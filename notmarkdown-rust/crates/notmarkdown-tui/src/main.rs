use std::{
    collections::BTreeSet,
    error::Error,
    fs, io,
    path::{Path, PathBuf},
    time::Duration,
};

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use notmarkdown_core::{
    Diagnostic, Document, IncrementalSearchCache, OutlineEntry, ParseResult, SearchHit, Severity,
    collect_asset_ids, outline, parse, render_terminal, search_index, terminal_block_offsets,
};
use notmarkdown_package::{
    AssetInput, OpenedPackage, extract_asset, open as open_package, repack_to,
    repack_with_asset_changes, update_package_search_cache,
};
use ratatui::{
    DefaultTerminal, Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block as UiBlock, Borders, Clear, Paragraph, Tabs, Wrap},
};

const TEMPLATE: &str = "@notmarkdown 0.1\n\n@document {\n  title: \"Untitled document\"\n  language: en\n  theme: standard\n}\n\n# Untitled document\n\nStart writing.\n";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum View {
    Document,
    Source,
    Package,
}

#[derive(Clone, Debug)]
enum NavigationOverlay {
    Outline {
        selected: usize,
    },
    SearchInput {
        query: String,
    },
    SearchResults {
        query: String,
        hits: Vec<SearchHit>,
        selected: usize,
        cache_status: String,
    },
}

impl View {
    fn index(self) -> usize {
        match self {
            Self::Document => 0,
            Self::Source => 1,
            Self::Package => 2,
        }
    }

    fn next(self) -> Self {
        match self {
            Self::Document => Self::Source,
            Self::Source => Self::Package,
            Self::Package => Self::Document,
        }
    }

    fn previous(self) -> Self {
        match self {
            Self::Document => Self::Package,
            Self::Source => Self::Document,
            Self::Package => Self::Source,
        }
    }
}

#[derive(Clone, Debug)]
struct SourceBuffer {
    lines: Vec<String>,
    row: usize,
    column: usize,
}

impl SourceBuffer {
    fn new(source: &str) -> Self {
        let mut lines: Vec<String> = source.split('\n').map(str::to_string).collect();
        if lines.is_empty() {
            lines.push(String::new());
        }
        Self {
            lines,
            row: 0,
            column: 0,
        }
    }

    fn text(&self) -> String {
        self.lines.join("\n")
    }

    fn current_len(&self) -> usize {
        self.lines[self.row].chars().count()
    }

    fn clamp(&mut self) {
        self.row = self.row.min(self.lines.len().saturating_sub(1));
        self.column = self.column.min(self.current_len());
    }

    fn insert(&mut self, character: char) {
        let offset = char_offset(&self.lines[self.row], self.column);
        self.lines[self.row].insert(offset, character);
        self.column += 1;
    }

    fn enter(&mut self) {
        let offset = char_offset(&self.lines[self.row], self.column);
        let tail = self.lines[self.row].split_off(offset);
        self.row += 1;
        self.lines.insert(self.row, tail);
        self.column = 0;
    }

    fn backspace(&mut self) {
        if self.column > 0 {
            let end = char_offset(&self.lines[self.row], self.column);
            let start = char_offset(&self.lines[self.row], self.column - 1);
            self.lines[self.row].replace_range(start..end, "");
            self.column -= 1;
        } else if self.row > 0 {
            let current = self.lines.remove(self.row);
            self.row -= 1;
            self.column = self.lines[self.row].chars().count();
            self.lines[self.row].push_str(&current);
        }
    }

    fn delete(&mut self) {
        if self.column < self.current_len() {
            let start = char_offset(&self.lines[self.row], self.column);
            let end = char_offset(&self.lines[self.row], self.column + 1);
            self.lines[self.row].replace_range(start..end, "");
        } else if self.row + 1 < self.lines.len() {
            let next = self.lines.remove(self.row + 1);
            self.lines[self.row].push_str(&next);
        }
    }
}

struct App {
    view: View,
    source: SourceBuffer,
    parsed: ParseResult,
    last_valid_document: Document,
    package: Option<OpenedPackage>,
    path: PathBuf,
    dirty: bool,
    should_quit: bool,
    quit_armed: bool,
    scroll: usize,
    status: String,
    save_number: usize,
    package_asset_index: usize,
    additions: Vec<AssetInput>,
    removals: BTreeSet<String>,
    asset_prompt: Option<String>,
    navigation: Option<NavigationOverlay>,
    search_cache: IncrementalSearchCache,
}

impl App {
    fn open(path: Option<PathBuf>) -> Result<Self, Box<dyn Error>> {
        let (path, source, package) = match path {
            Some(path) if extension(&path) == "nmdoc" => {
                let package = open_package(&path)?;
                (path, package.source.clone(), Some(package))
            }
            Some(path) => {
                let source = fs::read_to_string(&path)?;
                (path, source, None)
            }
            None => (PathBuf::from("untitled.nmt"), TEMPLATE.into(), None),
        };
        let parsed = parse(&source);
        let document = parsed.document.clone().ok_or_else(|| {
            let details = parsed
                .diagnostics
                .first()
                .map(|item| format!("{}: {}", item.code, item.message))
                .unwrap_or_else(|| "invalid source".into());
            io::Error::new(io::ErrorKind::InvalidData, details)
        })?;
        let status = package.as_ref().map_or_else(
            || "Local session · no network".into(),
            |package| {
                format!(
                    "Source verified · {} asset representation(s) deferred",
                    package.deferred_representations
                )
            },
        );
        Ok(Self {
            view: View::Document,
            source: SourceBuffer::new(&source),
            parsed,
            last_valid_document: document,
            package,
            path,
            dirty: false,
            should_quit: false,
            quit_armed: false,
            scroll: 0,
            status,
            save_number: 0,
            package_asset_index: 0,
            additions: Vec::new(),
            removals: BTreeSet::new(),
            asset_prompt: None,
            navigation: None,
            search_cache: IncrementalSearchCache::default(),
        })
    }

    fn run(&mut self, terminal: &mut DefaultTerminal) -> io::Result<()> {
        while !self.should_quit {
            terminal.draw(|frame| self.render(frame))?;
            if event::poll(Duration::from_millis(250))?
                && let Event::Key(key) = event::read()?
            {
                self.handle_key(key);
            }
        }
        Ok(())
    }

    fn handle_key(&mut self, key: KeyEvent) {
        if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
            return;
        }
        if self.asset_prompt.is_some() {
            self.handle_asset_prompt(key);
            return;
        }
        if self.navigation.is_some() {
            self.handle_navigation(key);
            return;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            match key.code {
                KeyCode::Char('q') => {
                    if self.dirty && !self.quit_armed {
                        self.quit_armed = true;
                        self.status = "Unsaved changes · press Ctrl+Q again to discard".into();
                    } else {
                        self.should_quit = true;
                    }
                    return;
                }
                KeyCode::Char('s') => {
                    self.save();
                    return;
                }
                KeyCode::Char('o') => {
                    self.open_outline();
                    return;
                }
                KeyCode::Char('f') => {
                    self.open_search();
                    return;
                }
                _ => {}
            }
        }
        match key.code {
            KeyCode::F(1) => self.set_view(View::Document),
            KeyCode::F(2) => self.set_view(View::Source),
            KeyCode::F(3) => self.set_view(View::Package),
            KeyCode::Tab => self.set_view(self.view.next()),
            KeyCode::BackTab => self.set_view(self.view.previous()),
            KeyCode::Char('x') if self.view == View::Package => self.extract_selected_asset(),
            KeyCode::Char('a') if self.view == View::Package => {
                if self.package.is_some() {
                    self.asset_prompt = Some(String::new());
                    self.status = "Enter: <asset-id> <file-path> · Esc cancels".into();
                } else {
                    self.status = "Open a .nmdoc package before adding assets".into();
                }
            }
            KeyCode::Char('d') if self.view == View::Package => self.toggle_selected_removal(),
            KeyCode::Char('j') if self.view == View::Package => {
                let count = self.asset_ids().len();
                self.package_asset_index =
                    (self.package_asset_index + 1).min(count.saturating_sub(1));
            }
            KeyCode::Char('k') if self.view == View::Package => {
                self.package_asset_index = self.package_asset_index.saturating_sub(1);
            }
            KeyCode::Char('/') if self.view == View::Document => self.open_search(),
            _ if self.view == View::Source => self.edit_source(key),
            KeyCode::Up => self.scroll = self.scroll.saturating_sub(1),
            KeyCode::Down => self.scroll = self.scroll.saturating_add(1),
            KeyCode::PageUp => self.scroll = self.scroll.saturating_sub(10),
            KeyCode::PageDown => self.scroll = self.scroll.saturating_add(10),
            KeyCode::Home => self.scroll = 0,
            _ => {}
        }
    }

    fn open_outline(&mut self) {
        self.navigation = Some(NavigationOverlay::Outline { selected: 0 });
        self.status = "Outline · j/k select · Enter jump · Esc close".into();
    }

    fn open_search(&mut self) {
        self.navigation = Some(NavigationOverlay::SearchInput {
            query: String::new(),
        });
        self.status = "Search document and embedded text · Enter runs · Esc cancels".into();
    }

    fn handle_navigation(&mut self, key: KeyEvent) {
        let Some(overlay) = self.navigation.take() else {
            return;
        };
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('q') {
            if self.dirty && !self.quit_armed {
                self.quit_armed = true;
                self.status = "Unsaved changes · press Ctrl+Q again to discard".into();
                self.navigation = Some(overlay);
            } else {
                self.should_quit = true;
            }
            return;
        }
        match overlay {
            NavigationOverlay::Outline { mut selected } => match key.code {
                KeyCode::Esc | KeyCode::Char('o')
                    if key.modifiers.contains(KeyModifiers::CONTROL)
                        || key.code == KeyCode::Esc =>
                {
                    self.status = "Outline closed".into();
                }
                KeyCode::Char('j') | KeyCode::Down => {
                    selected = (selected + 1)
                        .min(outline(&self.last_valid_document).len().saturating_sub(1));
                    self.navigation = Some(NavigationOverlay::Outline { selected });
                }
                KeyCode::Char('k') | KeyCode::Up => {
                    selected = selected.saturating_sub(1);
                    self.navigation = Some(NavigationOverlay::Outline { selected });
                }
                KeyCode::Enter => {
                    if let Some(entry) = outline(&self.last_valid_document).get(selected) {
                        let path = entry.path.clone();
                        let title = entry.title.clone();
                        self.jump_to_path(&path, &title);
                    } else {
                        self.status = "This document has no headings".into();
                    }
                }
                KeyCode::Char('/') => self.open_search(),
                _ => self.navigation = Some(NavigationOverlay::Outline { selected }),
            },
            NavigationOverlay::SearchInput { mut query } => match key.code {
                KeyCode::Esc => self.status = "Search cancelled".into(),
                KeyCode::Backspace => {
                    query.pop();
                    self.navigation = Some(NavigationOverlay::SearchInput { query });
                }
                KeyCode::Enter => {
                    let document_fingerprint = self.source.text();
                    let update = if let Some(package) = &self.package {
                        match update_package_search_cache(
                            &mut self.search_cache,
                            package,
                            &self.last_valid_document,
                            &document_fingerprint,
                        ) {
                            Ok(update) => update,
                            Err(error) => {
                                self.status = format!("Package search failed: {error}");
                                self.navigation = Some(NavigationOverlay::SearchInput { query });
                                return;
                            }
                        }
                    } else {
                        self.search_cache
                            .update(&self.last_valid_document, &document_fingerprint, &[])
                            .expect("loose document search has no asset cache misses")
                    };
                    let hits = search_index(&update.index, &query, 50);
                    let cache_status = format!(
                        "cache {} reused / {} rebuilt",
                        update.stats.assets_reused, update.stats.assets_reindexed
                    );
                    self.status = format!("{} result(s) · {cache_status}", hits.len());
                    self.navigation = Some(NavigationOverlay::SearchResults {
                        query,
                        hits,
                        selected: 0,
                        cache_status,
                    });
                }
                KeyCode::Char(character)
                    if !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
                {
                    query.push(character);
                    self.navigation = Some(NavigationOverlay::SearchInput { query });
                }
                _ => self.navigation = Some(NavigationOverlay::SearchInput { query }),
            },
            NavigationOverlay::SearchResults {
                query,
                hits,
                mut selected,
                cache_status,
            } => match key.code {
                KeyCode::Esc => self.status = "Search results closed".into(),
                KeyCode::Char('/') => {
                    self.navigation = Some(NavigationOverlay::SearchInput { query });
                }
                KeyCode::Char('j') | KeyCode::Down => {
                    selected = (selected + 1).min(hits.len().saturating_sub(1));
                    self.navigation = Some(NavigationOverlay::SearchResults {
                        query,
                        hits,
                        selected,
                        cache_status,
                    });
                }
                KeyCode::Char('k') | KeyCode::Up => {
                    selected = selected.saturating_sub(1);
                    self.navigation = Some(NavigationOverlay::SearchResults {
                        query,
                        hits,
                        selected,
                        cache_status,
                    });
                }
                KeyCode::Enter => {
                    if let Some(hit) = hits.get(selected) {
                        let path = hit.path.clone();
                        let label = hit.section.clone().unwrap_or_else(|| hit.kind.clone());
                        self.jump_to_path(&path, &label);
                    } else {
                        self.navigation = Some(NavigationOverlay::SearchInput { query });
                        self.status = "No results · edit the query".into();
                    }
                }
                _ => {
                    self.navigation = Some(NavigationOverlay::SearchResults {
                        query,
                        hits,
                        selected,
                        cache_status,
                    });
                }
            },
        }
    }

    fn jump_to_path(&mut self, path: &str, label: &str) {
        let Some(index) = top_level_block_index(path) else {
            self.status = format!("{label} is in definitions; open Source to edit it");
            return;
        };
        let offsets = terminal_block_offsets(&self.last_valid_document);
        self.view = View::Document;
        self.scroll = offsets.get(index).copied().unwrap_or(0);
        self.status = format!("Jumped to {label}");
    }

    fn set_view(&mut self, view: View) {
        self.view = view;
        self.scroll = if view == View::Source {
            self.source.row.saturating_sub(3)
        } else {
            0
        };
    }

    fn edit_source(&mut self, key: KeyEvent) {
        let mut changed = false;
        match key.code {
            KeyCode::Char(character)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                self.source.insert(character);
                changed = true;
            }
            KeyCode::Enter => {
                self.source.enter();
                changed = true;
            }
            KeyCode::Backspace => {
                self.source.backspace();
                changed = true;
            }
            KeyCode::Delete => {
                self.source.delete();
                changed = true;
            }
            KeyCode::Left => {
                if self.source.column > 0 {
                    self.source.column -= 1;
                } else if self.source.row > 0 {
                    self.source.row -= 1;
                    self.source.column = self.source.current_len();
                }
            }
            KeyCode::Right => {
                if self.source.column < self.source.current_len() {
                    self.source.column += 1;
                } else if self.source.row + 1 < self.source.lines.len() {
                    self.source.row += 1;
                    self.source.column = 0;
                }
            }
            KeyCode::Up => {
                self.source.row = self.source.row.saturating_sub(1);
                self.source.clamp();
            }
            KeyCode::Down => {
                self.source.row = (self.source.row + 1).min(self.source.lines.len() - 1);
                self.source.clamp();
            }
            KeyCode::Home => self.source.column = 0,
            KeyCode::End => self.source.column = self.source.current_len(),
            KeyCode::PageUp => {
                self.source.row = self.source.row.saturating_sub(10);
                self.source.clamp();
            }
            KeyCode::PageDown => {
                self.source.row = (self.source.row + 10).min(self.source.lines.len() - 1);
                self.source.clamp();
            }
            _ => {}
        }
        self.scroll = self
            .scroll
            .min(self.source.row)
            .max(self.source.row.saturating_sub(20));
        if changed {
            self.dirty = true;
            self.quit_armed = false;
            self.parsed = parse(&self.source.text());
            if let Some(document) = &self.parsed.document {
                self.last_valid_document = document.clone();
            }
            self.status = if self.parsed.is_valid() {
                "Valid source · unsaved".into()
            } else {
                "Invalid source · document view keeps the last valid tree".into()
            };
        }
    }

    fn asset_ids(&self) -> Vec<String> {
        let mut ids = BTreeSet::new();
        if let Some(package) = &self.package {
            ids.extend(package.manifest.assets.keys().cloned());
        }
        ids.extend(self.additions.iter().map(|asset| asset.id.clone()));
        ids.into_iter().collect()
    }

    fn selected_asset_id(&self) -> Option<String> {
        self.asset_ids().get(self.package_asset_index).cloned()
    }

    fn handle_asset_prompt(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => {
                self.asset_prompt = None;
                self.status = "Asset import cancelled".into();
            }
            KeyCode::Backspace => {
                self.asset_prompt.as_mut().and_then(String::pop);
            }
            KeyCode::Char(character)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                if let Some(prompt) = &mut self.asset_prompt {
                    prompt.push(character);
                }
            }
            KeyCode::Enter => {
                let value = self.asset_prompt.take().unwrap_or_default();
                let Some((id, raw_path)) = split_asset_prompt(&value) else {
                    self.status = "Add format: <asset-id> <file-path>".into();
                    return;
                };
                let path = expand_home(raw_path.trim());
                match AssetInput::from_path(id, path) {
                    Ok(asset) => {
                        let original_exists = self
                            .package
                            .as_ref()
                            .is_some_and(|package| package.manifest.assets.contains_key(&asset.id));
                        if self.additions.iter().any(|item| item.id == asset.id) {
                            self.status = format!("Asset {} is already staged", asset.id);
                        } else if original_exists && !self.removals.contains(&asset.id) {
                            self.status = format!(
                                "Asset {} exists · press d to stage removal before replacing it",
                                asset.id
                            );
                        } else {
                            let id = asset.id.clone();
                            self.additions.push(asset);
                            self.additions.sort_by(|a, b| a.id.cmp(&b.id));
                            self.dirty = true;
                            self.quit_armed = false;
                            self.package_asset_index = self
                                .asset_ids()
                                .iter()
                                .position(|candidate| candidate == &id)
                                .unwrap_or(0);
                            self.status =
                                format!("Staged asset {id} · Ctrl+S writes a new package");
                        }
                    }
                    Err(error) => self.status = format!("Cannot add asset: {error}"),
                }
            }
            _ => {}
        }
    }

    fn toggle_selected_removal(&mut self) {
        let Some(id) = self.selected_asset_id() else {
            self.status = "No asset selected".into();
            return;
        };
        if let Some(position) = self.additions.iter().position(|asset| asset.id == id) {
            self.additions.remove(position);
            self.dirty = true;
            self.status = format!("Unstaged new asset {id}");
            self.package_asset_index = self
                .package_asset_index
                .min(self.asset_ids().len().saturating_sub(1));
            return;
        }
        if self.removals.remove(&id) {
            self.dirty = true;
            self.status = format!("Kept asset {id}");
            return;
        }
        let referenced = self
            .parsed
            .document
            .as_ref()
            .map(collect_asset_ids)
            .unwrap_or_default();
        if referenced.contains(&id) {
            self.status = format!("Remove asset:{id} from Source before staging deletion");
            return;
        }
        self.removals.insert(id.clone());
        self.dirty = true;
        self.quit_armed = false;
        self.status = format!("Staged removal of {id} · press d again to undo");
    }

    fn save(&mut self) {
        if !self.parsed.is_valid() {
            self.status = "Cannot save: resolve source diagnostics first".into();
            return;
        }
        let source = self.source.text();
        let result: Result<PathBuf, Box<dyn Error>> = if let Some(package) = &self.package {
            let (target, number) = next_edited_package_path(&self.path, self.save_number);
            self.save_number = number;
            if self.additions.is_empty() && self.removals.is_empty() {
                repack_to(package, &source, &target)
                    .map_err(|error| -> Box<dyn Error> { Box::new(error) })
            } else {
                repack_with_asset_changes(
                    package,
                    &source,
                    &self.additions,
                    &self.removals,
                    &target,
                )
                .map_err(|error| -> Box<dyn Error> { Box::new(error) })
            }
        } else {
            fs::write(&self.path, source.as_bytes())
                .map(|()| self.path.clone())
                .map_err(|error| -> Box<dyn Error> { Box::new(error) })
        };
        match result {
            Ok(path) => {
                self.dirty = false;
                self.quit_armed = false;
                if extension(&path) == "nmdoc" {
                    match open_package(&path) {
                        Ok(package) => {
                            self.path = path.clone();
                            self.package = Some(package);
                            self.additions.clear();
                            self.removals.clear();
                            self.save_number = 0;
                            self.package_asset_index = self
                                .package_asset_index
                                .min(self.asset_ids().len().saturating_sub(1));
                        }
                        Err(error) => {
                            self.status = format!("Saved, but reopen failed: {error}");
                            return;
                        }
                    }
                }
                self.status = format!("Saved {}", path.display());
            }
            Err(error) => self.status = format!("Save failed: {error}"),
        }
    }

    fn extract_selected_asset(&mut self) {
        let Some(package) = &self.package else {
            self.status = "No package asset is available to extract".into();
            return;
        };
        let Some(id) = self.selected_asset_id() else {
            self.status = "This package has no assets".into();
            return;
        };
        if self.additions.iter().any(|asset| asset.id == id) {
            self.status = format!("Asset {id} is staged locally and not packaged yet");
            return;
        }
        let stem = self
            .path
            .file_stem()
            .and_then(|item| item.to_str())
            .unwrap_or("document");
        let directory = self.path.with_file_name(format!("{stem}.assets"));
        match extract_asset(package, &id, &directory) {
            Ok(paths) => {
                self.status = format!(
                    "Extracted {} representation(s) for {id} to {}",
                    paths.len(),
                    directory.display()
                );
            }
            Err(error) => self.status = format!("Extraction failed: {error}"),
        }
    }

    fn render(&self, frame: &mut Frame<'_>) {
        let [header, status, body, diagnostic, footer] = Layout::vertical([
            Constraint::Length(3),
            Constraint::Length(1),
            Constraint::Min(5),
            Constraint::Length(2),
            Constraint::Length(1),
        ])
        .areas(frame.area());
        self.render_tabs(frame, header);
        self.render_status(frame, status);
        match self.view {
            View::Document => self.render_document(frame, body),
            View::Source => self.render_source(frame, body),
            View::Package => self.render_package(frame, body),
        }
        if self.asset_prompt.is_some() {
            self.render_asset_prompt(frame, diagnostic);
        } else {
            self.render_diagnostic(frame, diagnostic);
        }
        frame.render_widget(
            Paragraph::new(if self.view == View::Package {
                "j/k select  a add  d remove/undo  x extract  Ctrl+S repack  Ctrl+Q quit"
            } else {
                "F1/F2/F3 views  Ctrl+O outline  / or Ctrl+F search  Ctrl+S save  Ctrl+Q quit"
            })
            .style(Style::default().fg(Color::DarkGray)),
            footer,
        );
        if self.navigation.is_some() {
            self.render_navigation(frame);
        }
    }

    fn render_tabs(&self, frame: &mut Frame<'_>, area: Rect) {
        let titles = ["Document", "Source", "Package"];
        let tabs = Tabs::new(titles)
            .select(self.view.index())
            .divider("  ")
            .highlight_style(
                Style::default()
                    .fg(Color::White)
                    .bg(Color::Rgb(90, 72, 220))
                    .add_modifier(Modifier::BOLD),
            )
            .block(
                UiBlock::default()
                    .borders(Borders::ALL)
                    .title(" NotMarkdown Terminal Studio "),
            );
        frame.render_widget(tabs, area);
    }

    fn render_status(&self, frame: &mut Frame<'_>, area: Rect) {
        let validity = if self.parsed.is_valid() {
            Span::styled("● valid", Style::default().fg(Color::Green))
        } else {
            Span::styled(
                format!("● {} diagnostics", self.parsed.diagnostics.len()),
                Style::default().fg(Color::Red),
            )
        };
        let dirty = if self.dirty { " · modified" } else { "" };
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::raw(format!(" {}{dirty}  ", self.path.display())),
                validity,
                Span::raw(format!("  · {}", self.status)),
            ])),
            area,
        );
    }

    fn render_document(&self, frame: &mut Frame<'_>, area: Rect) {
        let lines = render_terminal(&self.last_valid_document)
            .into_iter()
            .map(Line::from)
            .collect::<Vec<_>>();
        let paragraph = Paragraph::new(lines)
            .block(UiBlock::bordered().title(" Semantic document view "))
            .scroll((self.scroll.min(u16::MAX as usize) as u16, 0))
            .wrap(Wrap { trim: false });
        frame.render_widget(paragraph, area);
    }

    fn render_source(&self, frame: &mut Frame<'_>, area: Rect) {
        let gutter = self.source.lines.len().to_string().len().max(2);
        let invalid_lines: std::collections::BTreeSet<usize> = self
            .parsed
            .diagnostics
            .iter()
            .map(|item| item.line.saturating_sub(1))
            .collect();
        let lines = self
            .source
            .lines
            .iter()
            .enumerate()
            .map(|(index, line)| {
                let style = if invalid_lines.contains(&index) {
                    Style::default().fg(Color::LightRed)
                } else if index == self.source.row {
                    Style::default().bg(Color::Rgb(38, 40, 54))
                } else {
                    Style::default()
                };
                Line::from(vec![
                    Span::styled(
                        format!("{:>gutter$} │ ", index + 1),
                        Style::default().fg(Color::DarkGray),
                    ),
                    Span::styled(line.clone(), source_style(line).patch(style)),
                ])
            })
            .collect::<Vec<_>>();
        frame.render_widget(
            Paragraph::new(Text::from(lines))
                .block(UiBlock::bordered().title(" document.nmt · editable "))
                .scroll((self.scroll.min(u16::MAX as usize) as u16, 0)),
            area,
        );
        let visible_row = self.source.row.saturating_sub(self.scroll);
        if visible_row < area.height.saturating_sub(2) as usize {
            let x =
                area.x + 1 + gutter as u16 + 3 + self.source.column.min(u16::MAX as usize) as u16;
            let y = area.y + 1 + visible_row as u16;
            frame.set_cursor_position((x.min(area.right().saturating_sub(1)), y));
        }
    }

    fn render_package(&self, frame: &mut Frame<'_>, area: Rect) {
        let lines = if let Some(package) = &self.package {
            package_lines(
                package,
                &self.additions,
                &self.removals,
                self.package_asset_index,
            )
        } else {
            vec![
                Line::styled(
                    "Loose .nmt source",
                    Style::default().fg(Color::Yellow).bold(),
                ),
                Line::from(""),
                Line::from(
                    "No package is open. Embedded assets and representations are unavailable.",
                ),
                Line::from(
                    "Open a .nmdoc file to inspect metadata, hashes, compression, and fallbacks.",
                ),
            ]
        };
        frame.render_widget(
            Paragraph::new(lines)
                .block(UiBlock::bordered().title(" Package inspection "))
                .scroll((self.scroll.min(u16::MAX as usize) as u16, 0))
                .wrap(Wrap { trim: false }),
            area,
        );
    }

    fn render_diagnostic(&self, frame: &mut Frame<'_>, area: Rect) {
        let content = self
            .parsed
            .diagnostics
            .first()
            .map(diagnostic_line)
            .unwrap_or_else(|| {
                Line::styled("No source diagnostics", Style::default().fg(Color::Green))
            });
        frame.render_widget(
            Paragraph::new(content).block(UiBlock::default().borders(Borders::TOP)),
            area,
        );
    }

    fn render_asset_prompt(&self, frame: &mut Frame<'_>, area: Rect) {
        let prompt = self.asset_prompt.as_deref().unwrap_or_default();
        frame.render_widget(
            Paragraph::new(format!("Add asset: {prompt}"))
                .style(Style::default().fg(Color::LightCyan))
                .block(UiBlock::default().borders(Borders::TOP)),
            area,
        );
        let x = area
            .x
            .saturating_add(11)
            .saturating_add(prompt.chars().count().min(u16::MAX as usize) as u16)
            .min(area.right().saturating_sub(1));
        frame.set_cursor_position((x, area.y + 1));
    }

    fn render_navigation(&self, frame: &mut Frame<'_>) {
        let area = centered_popup(frame.area(), 84, 72);
        frame.render_widget(Clear, area);
        match self.navigation.as_ref().expect("navigation is open") {
            NavigationOverlay::Outline { selected } => {
                let entries = outline(&self.last_valid_document);
                let lines = if entries.is_empty() {
                    vec![Line::styled(
                        "No headings yet. Add # headings in Source.",
                        Style::default().fg(Color::Yellow),
                    )]
                } else {
                    outline_lines(&entries, *selected)
                };
                let scroll = selected.saturating_sub(area.height.saturating_sub(4) as usize / 2);
                frame.render_widget(
                    Paragraph::new(lines)
                        .block(
                            UiBlock::bordered()
                                .title(" Automatic outline · j/k move · Enter jump · / search "),
                        )
                        .scroll((scroll.min(u16::MAX as usize) as u16, 0)),
                    area,
                );
            }
            NavigationOverlay::SearchInput { query } => {
                frame.render_widget(
                    Paragraph::new(vec![
                        Line::from(
                            "Search document text plus embedded captions, transcripts, and attachments.",
                        ),
                        Line::from(""),
                        Line::styled(format!("› {query}"), Style::default().fg(Color::LightCyan)),
                        Line::from(""),
                        Line::styled(
                            "Enter search · Esc cancel",
                            Style::default().fg(Color::DarkGray),
                        ),
                    ])
                    .block(UiBlock::bordered().title(" Full-text search ")),
                    area,
                );
                let x = area
                    .x
                    .saturating_add(3)
                    .saturating_add(query.chars().count().min(u16::MAX as usize) as u16)
                    .min(area.right().saturating_sub(2));
                frame.set_cursor_position((x, area.y.saturating_add(3)));
            }
            NavigationOverlay::SearchResults {
                query,
                hits,
                selected,
                cache_status,
            } => {
                let lines = if hits.is_empty() {
                    vec![Line::styled(
                        format!("No results for “{query}” · press / to edit"),
                        Style::default().fg(Color::Yellow),
                    )]
                } else {
                    hits.iter()
                        .enumerate()
                        .map(|(index, hit)| {
                            let marker = if index == *selected { "›" } else { " " };
                            let section = hit
                                .section
                                .as_ref()
                                .map(|value| format!(" · {value}"))
                                .unwrap_or_default();
                            let asset = hit
                                .asset_id
                                .as_ref()
                                .map(|value| format!(" · asset:{value}"))
                                .unwrap_or_default();
                            Line::styled(
                                format!(
                                    "{marker} [{} · {}{}{}] {}",
                                    hit.score, hit.kind, asset, section, hit.context
                                ),
                                if index == *selected {
                                    Style::default().fg(Color::Black).bg(Color::LightCyan)
                                } else {
                                    Style::default().fg(Color::Gray)
                                },
                            )
                        })
                        .collect()
                };
                let scroll = selected.saturating_sub(area.height.saturating_sub(4) as usize / 2);
                frame.render_widget(
                    Paragraph::new(lines)
                        .block(UiBlock::bordered().title(format!(
                            " Search · {query} · {cache_status} · j/k · Enter · / edit "
                        )))
                        .scroll((scroll.min(u16::MAX as usize) as u16, 0)),
                    area,
                );
            }
        }
    }
}

fn outline_lines(entries: &[OutlineEntry], selected: usize) -> Vec<Line<'static>> {
    entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let marker = if index == selected { "›" } else { " " };
            let id = entry
                .id
                .as_ref()
                .map(|value| format!("  #{value}"))
                .unwrap_or_default();
            Line::styled(
                format!(
                    "{marker} {}{}{}",
                    "  ".repeat(entry.level.saturating_sub(1) as usize),
                    entry.title,
                    id
                ),
                if index == selected {
                    Style::default().fg(Color::Black).bg(Color::LightMagenta)
                } else {
                    Style::default().fg(Color::Gray)
                },
            )
        })
        .collect()
}

fn centered_popup(area: Rect, width_percent: u16, height_percent: u16) -> Rect {
    let [vertical] = Layout::vertical([Constraint::Percentage(height_percent)])
        .flex(ratatui::layout::Flex::Center)
        .areas(area);
    let [centered] = Layout::horizontal([Constraint::Percentage(width_percent)])
        .flex(ratatui::layout::Flex::Center)
        .areas(vertical);
    centered
}

fn top_level_block_index(path: &str) -> Option<usize> {
    path.strip_prefix("/children/")?
        .split('/')
        .next()?
        .parse()
        .ok()
}

fn package_lines(
    package: &OpenedPackage,
    additions: &[AssetInput],
    removals: &BTreeSet<String>,
    selected_asset: usize,
) -> Vec<Line<'static>> {
    let mut lines = vec![
        Line::styled("METADATA", Style::default().fg(Color::Magenta).bold()),
        Line::from(format!(
            "  profile: {} · media: {} · theme: {}",
            package.manifest.container_profile,
            package.manifest.media_profile,
            package.manifest.theme_profile
        )),
    ];
    for (key, value) in &package.document.metadata {
        lines.push(Line::from(format!("  {key}: {}", display_json(value))));
    }
    lines.push(Line::from(""));
    let mut ids: BTreeSet<String> = package.manifest.assets.keys().cloned().collect();
    ids.extend(additions.iter().map(|asset| asset.id.clone()));
    lines.push(Line::styled(
        format!(
            "ASSETS · {} active · {} added · {} removed",
            ids.len().saturating_sub(removals.len()),
            additions.len(),
            removals.len()
        ),
        Style::default().fg(Color::Cyan).bold(),
    ));
    for (index, id) in ids.iter().enumerate() {
        let staged = additions.iter().find(|asset| &asset.id == id);
        let removed = removals.contains(id);
        let marker = if index == selected_asset {
            "›"
        } else if staged.is_some() {
            "+"
        } else if removed {
            "×"
        } else {
            " "
        };
        let (kind, details) = if let Some(asset) = staged {
            (
                asset.kind.as_str(),
                vec![format!(
                    "    staged · {} · {}",
                    asset.media_type,
                    asset.path.display()
                )],
            )
        } else {
            let asset = &package.manifest.assets[id];
            (
                asset.kind.as_str(),
                asset
                    .representations
                    .iter()
                    .map(|representation| {
                        format!(
                            "    {} · {} · {} · {} bytes",
                            representation.role,
                            representation.media_type,
                            representation.path,
                            representation.bytes
                        )
                    })
                    .collect(),
            )
        };
        lines.push(Line::styled(
            format!(
                "{marker} {id} [{kind}]{}",
                if removed { " · REMOVE" } else { "" }
            ),
            if removed {
                Style::default().fg(Color::LightRed)
            } else if staged.is_some() {
                Style::default().fg(Color::LightGreen)
            } else if index == selected_asset {
                Style::default().fg(Color::LightCyan).bold()
            } else {
                Style::default()
            },
        ));
        for detail in details {
            lines.push(Line::from(detail));
        }
        if matches!(kind, "audio" | "video") {
            lines.push(Line::styled(
                "    terminal fallback: label/poster/captions/transcript; no autoplay",
                Style::default().fg(Color::Yellow),
            ));
        }
    }
    lines.push(Line::from(""));
    lines.push(Line::styled(
        format!("ENTRIES · {}", package.entries.len()),
        Style::default().fg(Color::Blue).bold(),
    ));
    for entry in &package.entries {
        lines.push(Line::from(format!(
            "  {:<12} {:>9} → {:>9}  {}",
            entry.compression,
            format_bytes(entry.uncompressed_bytes),
            format_bytes(entry.compressed_bytes),
            entry.path
        )));
    }
    lines
}

fn source_style(line: &str) -> Style {
    let trimmed = line.trim_start();
    if trimmed.starts_with('#') {
        Style::default().fg(Color::LightMagenta).bold()
    } else if trimmed.starts_with('@') {
        Style::default().fg(Color::Yellow)
    } else if trimmed.starts_with('!') {
        Style::default().fg(Color::LightCyan)
    } else if trimmed.starts_with("1. ") || trimmed.starts_with("- ") {
        Style::default().fg(Color::LightBlue)
    } else {
        Style::default().fg(Color::Gray)
    }
}

fn diagnostic_line(diagnostic: &Diagnostic) -> Line<'static> {
    let color = match diagnostic.severity {
        Severity::Error => Color::LightRed,
        Severity::Warning => Color::Yellow,
    };
    Line::styled(
        format!(
            "{} at {}:{} · {}",
            diagnostic.code, diagnostic.line, diagnostic.column, diagnostic.message
        ),
        Style::default().fg(color),
    )
}

fn display_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(value) => value.clone(),
        _ => value.to_string(),
    }
}

fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KiB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MiB", bytes as f64 / 1024.0 / 1024.0)
    }
}

fn edited_package_path(path: &Path, number: usize) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(|item| item.to_str())
        .unwrap_or("document");
    let suffix = if number == 1 {
        ".edited.nmdoc".into()
    } else {
        format!(".edited-{number}.nmdoc")
    };
    path.with_file_name(format!("{stem}{suffix}"))
}

fn next_edited_package_path(path: &Path, previous: usize) -> (PathBuf, usize) {
    let mut number = previous + 1;
    loop {
        let candidate = edited_package_path(path, number);
        if !candidate.exists() {
            return (candidate, number);
        }
        number += 1;
    }
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|item| item.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn split_asset_prompt(value: &str) -> Option<(&str, &str)> {
    let value = value.trim();
    let separator = value.find(char::is_whitespace)?;
    let id = &value[..separator];
    let path = value[separator..].trim();
    (!id.is_empty() && !path.is_empty()).then_some((id, path))
}

fn expand_home(value: &str) -> PathBuf {
    if value == "~" {
        return home_directory().unwrap_or_else(|| PathBuf::from(value));
    }
    if let Some(relative) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
        && let Some(home) = home_directory()
    {
        return home.join(relative);
    }
    PathBuf::from(value)
}

fn home_directory() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn char_offset(value: &str, character_index: usize) -> usize {
    value
        .char_indices()
        .nth(character_index)
        .map(|(offset, _)| offset)
        .unwrap_or(value.len())
}

fn main() -> Result<(), Box<dyn Error>> {
    let argument = std::env::args_os().nth(1).map(PathBuf::from);
    let mut app = App::open(argument)?;
    let mut terminal = ratatui::try_init()?;
    let result = app.run(&mut terminal);
    ratatui::restore();
    result.map_err(|error| error.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_buffer_edits_unicode_by_character() {
        let mut buffer = SourceBuffer::new("Aø");
        buffer.column = 1;
        buffer.insert('🙂');
        assert_eq!(buffer.text(), "A🙂ø");
        buffer.backspace();
        assert_eq!(buffer.text(), "Aø");
    }

    #[test]
    fn package_saves_never_overwrite_the_open_file() {
        let path = Path::new("report.nmdoc");
        assert_eq!(
            edited_package_path(path, 1),
            PathBuf::from("report.edited.nmdoc")
        );
        assert_eq!(
            edited_package_path(path, 2),
            PathBuf::from("report.edited-2.nmdoc")
        );
    }

    #[test]
    fn asset_prompt_keeps_spaces_in_paths() {
        assert_eq!(
            split_asset_prompt("diagram /tmp/my diagram.svg"),
            Some(("diagram", "/tmp/my diagram.svg"))
        );
        assert_eq!(split_asset_prompt("missing-path"), None);
    }

    #[test]
    fn navigation_overlay_searches_and_jumps_without_a_fourth_view() {
        let mut app = App::open(None).expect("open template");
        app.open_outline();
        assert!(matches!(
            app.navigation,
            Some(NavigationOverlay::Outline { selected: 0 })
        ));
        app.handle_navigation(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.view, View::Document);
        assert_eq!(app.scroll, 3);
        assert!(app.navigation.is_none());

        app.open_search();
        for character in "writing".chars() {
            app.handle_navigation(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE));
        }
        app.handle_navigation(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        let Some(NavigationOverlay::SearchResults { hits, .. }) = &app.navigation else {
            panic!("expected search results");
        };
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "paragraph");
    }

    #[test]
    fn navigation_paths_resolve_only_document_blocks() {
        assert_eq!(top_level_block_index("/children/12/children/0"), Some(12));
        assert_eq!(top_level_block_index("/definitions/footnotes/note/0"), None);
    }

    #[test]
    fn terminal_search_includes_verified_transcript_assets() {
        let examples = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../notmarkdown-reference-parser/examples");
        let source =
            fs::read_to_string(examples.join("search-package.nmt")).expect("search source");
        let assets = [
            ("search-demo", "search-demo.webm"),
            ("search-captions", "search-captions.vtt"),
            ("search-transcript", "search-transcript.txt"),
            ("search-notes", "search-notes.md"),
        ]
        .into_iter()
        .map(|(id, file)| AssetInput::from_path(id, examples.join(file)).expect("asset"))
        .collect::<Vec<_>>();
        let package_path = std::env::temp_dir().join(format!(
            "notmarkdown-tui-search-assets-{}.nmdoc",
            std::process::id()
        ));
        let _ = fs::remove_file(&package_path);
        notmarkdown_package::create_package(
            &source,
            &assets,
            notmarkdown_package::ContainerProfile::Portable,
            &package_path,
        )
        .expect("create search package");

        let mut app = App::open(Some(package_path.clone())).expect("open package");
        app.open_search();
        for character in "silent magnetic".chars() {
            app.handle_navigation(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE));
        }
        app.handle_navigation(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        let Some(NavigationOverlay::SearchResults { hits, .. }) = &app.navigation else {
            panic!("expected package search results");
        };
        assert_eq!(hits[0].asset_id.as_deref(), Some("search-transcript"));
        assert_eq!(hits[0].kind, "transcript");

        app.open_search();
        for character in "silent magnetic".chars() {
            app.handle_navigation(KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE));
        }
        app.handle_navigation(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(app.status.contains("cache 3 reused / 0 rebuilt"));
        fs::remove_file(package_path).expect("remove package");
    }
}
