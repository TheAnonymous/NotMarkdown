//! Safe `.nmdoc` package reading plus deterministic source-preserving repacks.

use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt,
    fs::{File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use notmarkdown_core::{
    CachedSearchAsset, Diagnostic, Document, IncrementalSearchCache, MAX_SEARCH_ASSET_BYTES,
    MAX_TOTAL_SEARCH_ASSET_BYTES, SearchCacheUpdate, SearchIndex, collect_asset_ids,
    is_searchable_media_type, parse,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::{
    CompressionMethod, DateTime, ZipArchive, ZipWriter, result::ZipError, write::SimpleFileOptions,
};

const MIMETYPE: &str = "application/vnd.notmarkdown.document+zip";

#[derive(Clone, Debug)]
pub struct ReadLimits {
    pub max_entries: usize,
    pub max_entry_bytes: u64,
    pub max_total_bytes: u64,
    pub max_compression_ratio: u64,
}

impl Default for ReadLimits {
    fn default() -> Self {
        Self {
            max_entries: 4096,
            max_entry_bytes: 512 * 1024 * 1024,
            max_total_bytes: 2 * 1024 * 1024 * 1024,
            max_compression_ratio: 200,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub package_version: String,
    pub source: String,
    pub source_sha256: String,
    pub container_profile: ContainerProfile,
    pub theme_profile: String,
    pub media_profile: String,
    pub assets: BTreeMap<String, ManifestAsset>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContainerProfile {
    #[serde(rename = "modern-0.1")]
    Modern,
    #[serde(rename = "portable-0.1")]
    Portable,
}

impl fmt::Display for ContainerProfile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Modern => "modern-0.1",
            Self::Portable => "portable-0.1",
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestAsset {
    pub kind: String,
    pub representations: Vec<Representation>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Representation {
    pub path: String,
    pub media_type: String,
    pub role: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryInfo {
    pub path: String,
    pub compression: String,
    pub compressed_bytes: u64,
    pub uncompressed_bytes: u64,
}

#[derive(Clone, Debug)]
pub struct OpenedPackage {
    pub path: PathBuf,
    pub manifest: Manifest,
    pub source: String,
    pub document: Document,
    pub diagnostics: Vec<Diagnostic>,
    pub entries: Vec<EntryInfo>,
    pub deferred_representations: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetInput {
    pub id: String,
    pub path: PathBuf,
    pub media_type: String,
    pub kind: String,
    pub role: String,
}

impl AssetInput {
    pub fn from_path(
        id: impl Into<String>,
        path: impl Into<PathBuf>,
    ) -> Result<Self, PackageError> {
        let id = id.into();
        validate_asset_id(&id)?;
        let path = path.into();
        if !path.is_file() {
            return Err(format_error(format!(
                "Asset source {} is not a regular file.",
                path.display()
            )));
        }
        let media_type = infer_media_type(&path).to_string();
        let kind = infer_kind(&path, &media_type).to_string();
        let role = infer_role(&kind).to_string();
        Ok(Self {
            id,
            path,
            media_type,
            kind,
            role,
        })
    }
}

#[derive(Debug)]
pub enum PackageError {
    Io(io::Error),
    Zip(ZipError),
    Json(serde_json::Error),
    Format(String),
}

impl fmt::Display for PackageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "I/O error: {error}"),
            Self::Zip(error) => write!(formatter, "ZIP error: {error}"),
            Self::Json(error) => write!(formatter, "Manifest JSON error: {error}"),
            Self::Format(message) => formatter.write_str(message),
        }
    }
}

impl Error for PackageError {}

impl From<io::Error> for PackageError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<ZipError> for PackageError {
    fn from(value: ZipError) -> Self {
        Self::Zip(value)
    }
}

impl From<serde_json::Error> for PackageError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

pub fn open(path: impl AsRef<Path>) -> Result<OpenedPackage, PackageError> {
    open_with_limits(path, &ReadLimits::default())
}

/// Stream and verify every deferred representation without retaining its
/// bytes. Useful for explicit audits; normal editor open remains metadata-first.
pub fn verify_all(package: &OpenedPackage) -> Result<usize, PackageError> {
    let file = File::open(&package.path)?;
    let mut archive = ZipArchive::new(file)?;
    let mut verified = 0_usize;
    for (id, asset) in &package.manifest.assets {
        for representation in &asset.representations {
            copy_verified_representation(&mut archive, id, representation, &mut io::sink())?;
            verified += 1;
        }
    }
    Ok(verified)
}

/// Read one explicitly selected representation into memory after enforcing a
/// caller-provided limit and verifying its declared length and SHA-256. This
/// is intended for bounded exporters and previews; bulk media should continue
/// to use the streaming extraction APIs.
pub fn read_asset_representation(
    package: &OpenedPackage,
    asset_id: &str,
    representation_path: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, PackageError> {
    if max_bytes == 0 {
        return Err(format_error("Representation byte limit must be positive."));
    }
    let asset = package
        .manifest
        .assets
        .get(asset_id)
        .ok_or_else(|| format_error(format!("Unknown asset {asset_id}.")))?;
    let representation = asset
        .representations
        .iter()
        .find(|representation| representation.path == representation_path)
        .ok_or_else(|| {
            format_error(format!(
                "Asset {asset_id} has no representation {representation_path}."
            ))
        })?;
    validate_path(&representation.path)?;
    if representation.bytes > max_bytes as u64 {
        return Err(format_error(format!(
            "Representation {} exceeds its in-memory byte limit.",
            representation.path
        )));
    }
    let file = File::open(&package.path)?;
    let mut archive = ZipArchive::new(file)?;
    let bytes = read_small(&mut archive, &representation.path, max_bytes)?;
    verify_representation_bytes(asset_id, representation, &bytes)?;
    Ok(bytes)
}

/// Build the deterministic package-wide index from the verified document and
/// its safe textual representations. The result is disposable and is never
/// written back into the package.
pub fn build_package_search_index(package: &OpenedPackage) -> Result<SearchIndex, PackageError> {
    build_package_search_index_for_document(package, &package.document)
}

/// Package search for the editor's current valid document tree. This keeps
/// embedded asset text searchable while unsaved source edits are in progress.
pub fn build_package_search_index_for_document(
    package: &OpenedPackage,
    document: &Document,
) -> Result<SearchIndex, PackageError> {
    let mut cache = IncrementalSearchCache::default();
    Ok(update_package_search_cache(
        &mut cache,
        package,
        document,
        &package.manifest.source_sha256,
    )?
    .index)
}

/// Incrementally update a session cache. Verified SHA-256 representation
/// fingerprints decide which ZIP entries must be read and decoded again.
pub fn update_package_search_cache(
    cache: &mut IncrementalSearchCache,
    package: &OpenedPackage,
    document: &Document,
    document_fingerprint: &str,
) -> Result<SearchCacheUpdate, PackageError> {
    let mut archive: Option<ZipArchive<File>> = None;
    let mut assets = Vec::new();
    let mut total_bytes = 0_usize;
    for (id, asset) in &package.manifest.assets {
        let mut representations: Vec<_> = asset.representations.iter().collect();
        representations.sort_by(|left, right| left.path.cmp(&right.path));
        for representation in representations {
            let bytes = usize::try_from(representation.bytes).unwrap_or(usize::MAX);
            let eligible = is_searchable_media_type(&representation.media_type)
                && bytes <= MAX_SEARCH_ASSET_BYTES
                && total_bytes.saturating_add(bytes) <= MAX_TOTAL_SEARCH_ASSET_BYTES;
            if eligible {
                total_bytes += bytes;
            }
            let cached = cache.contains_asset(
                id,
                &representation.path,
                &representation.media_type,
                &representation.sha256,
            );
            let data = if eligible && !cached {
                if archive.is_none() {
                    archive = Some(ZipArchive::new(File::open(&package.path)?)?);
                }
                let data = read_small(
                    archive.as_mut().expect("archive initialized"),
                    &representation.path,
                    MAX_SEARCH_ASSET_BYTES,
                )?;
                verify_representation_bytes(id, representation, &data)?;
                Some(data)
            } else {
                None
            };
            assets.push(CachedSearchAsset {
                id: id.clone(),
                package_path: representation.path.clone(),
                media_type: representation.media_type.clone(),
                fingerprint: representation.sha256.clone(),
                bytes,
                data,
            });
        }
    }
    cache
        .update(document, document_fingerprint, &assets)
        .map_err(|error| format_error(error.to_string()))
}

/// Create a deterministic package from valid source and loose asset files.
/// The target is written atomically and must not already exist.
pub fn create_package(
    source: &str,
    assets: &[AssetInput],
    profile: ContainerProfile,
    target: impl AsRef<Path>,
) -> Result<PathBuf, PackageError> {
    let normalized = normalize_source(source);
    let parsed = parse(&normalized);
    let document = parsed.document.ok_or_else(|| {
        let message = parsed
            .diagnostics
            .first()
            .map(|item| format!("{}: {}", item.code, item.message))
            .unwrap_or_else(|| "invalid source".into());
        format_error(format!("Cannot package invalid source: {message}"))
    })?;
    let referenced = collect_asset_ids(&document);

    let mut inputs: Vec<&AssetInput> = assets.iter().collect();
    inputs.sort_by(|left, right| left.id.cmp(&right.id));
    let mut manifest_assets = BTreeMap::new();
    let mut asset_sources = BTreeMap::new();
    let mut paths = BTreeSet::new();
    for input in inputs {
        validate_asset_id(&input.id)?;
        if !input.path.is_file() {
            return Err(format_error(format!(
                "Asset source {} is not a regular file.",
                input.path.display()
            )));
        }
        if manifest_assets.contains_key(&input.id) {
            return Err(format_error(format!(
                "Asset {} is supplied more than once.",
                input.id
            )));
        }
        if !referenced.contains(&input.id) {
            return Err(format_error(format!(
                "Asset {} is not referenced by the source.",
                input.id
            )));
        }
        let extension = asset_extension(&input.path, &input.media_type);
        let internal_path = format!("assets/{}{}", input.id, extension);
        if !paths.insert(internal_path.clone()) {
            return Err(format_error(format!(
                "Two assets resolve to {internal_path}."
            )));
        }
        let (bytes, digest) = hash_file(&input.path)?;
        manifest_assets.insert(
            input.id.clone(),
            ManifestAsset {
                kind: input.kind.clone(),
                representations: vec![Representation {
                    path: internal_path.clone(),
                    media_type: input.media_type.clone(),
                    role: input.role.clone(),
                    bytes,
                    sha256: digest,
                }],
            },
        );
        asset_sources.insert(internal_path, input.path.clone());
    }

    let packaged: BTreeSet<String> = manifest_assets.keys().cloned().collect();
    if referenced != packaged {
        let missing: Vec<_> = referenced.difference(&packaged).cloned().collect();
        let unused: Vec<_> = packaged.difference(&referenced).cloned().collect();
        return Err(format_error(format!(
            "Asset inputs do not match source references (missing: {}; unused: {}).",
            missing.join(", "),
            unused.join(", ")
        )));
    }

    let manifest = Manifest {
        format: "notmarkdown".into(),
        package_version: "0.1".into(),
        source: "document.nmt".into(),
        source_sha256: sha256_hex(normalized.as_bytes()),
        container_profile: profile,
        theme_profile: "0.1".into(),
        media_profile: "2026-draft".into(),
        assets: manifest_assets,
    };
    let target = target.as_ref().to_path_buf();
    if target.exists() {
        return Err(format_error(format!(
            "Refusing to overwrite existing file {}.",
            target.display()
        )));
    }
    if let Some(parent) = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    let temp = temporary_sibling(&target);
    let result = write_new_package(&normalized, &manifest, &asset_sources, &temp);
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    std::fs::rename(&temp, &target)?;
    Ok(target)
}

pub fn open_with_limits(
    path: impl AsRef<Path>,
    limits: &ReadLimits,
) -> Result<OpenedPackage, PackageError> {
    let path = path.as_ref().to_path_buf();
    let file = File::open(&path)?;
    let mut archive = ZipArchive::new(file)?;
    if archive.len() > limits.max_entries {
        return Err(format_error("Package contains too many entries."));
    }
    if archive.is_empty() {
        return Err(format_error("Package is empty."));
    }

    let mut entries = Vec::with_capacity(archive.len());
    let mut paths = BTreeSet::new();
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        let path = entry.name().to_string();
        validate_path(&path)?;
        if !paths.insert(path.clone()) {
            return Err(format_error(format!("Duplicate package entry {path}.")));
        }
        let expanded = entry.size();
        let compressed = entry.compressed_size();
        if expanded > limits.max_entry_bytes {
            return Err(format_error(format!(
                "Entry {path} exceeds the size limit."
            )));
        }
        total = total
            .checked_add(expanded)
            .ok_or_else(|| format_error("Expanded package size overflow."))?;
        if total > limits.max_total_bytes {
            return Err(format_error(
                "Package exceeds the total expanded-size limit.",
            ));
        }
        if compressed > 0 && expanded / compressed.max(1) > limits.max_compression_ratio {
            return Err(format_error(format!(
                "Entry {path} exceeds the compression-ratio limit."
            )));
        }
        entries.push(EntryInfo {
            path,
            compression: compression_name(entry.compression()).into(),
            compressed_bytes: compressed,
            uncompressed_bytes: expanded,
        });
    }

    let (first_name, first_method) = {
        let first = archive.by_index(0)?;
        (first.name().to_string(), first.compression())
    };
    if first_name != "mimetype" || first_method != CompressionMethod::Stored {
        return Err(format_error(
            "The first entry must be an uncompressed mimetype entry.",
        ));
    }
    let mimetype = read_small(&mut archive, "mimetype", 256)?;
    if mimetype != MIMETYPE.as_bytes() {
        return Err(format_error("Invalid NotMarkdown mimetype."));
    }

    let manifest_bytes = read_small(&mut archive, "manifest.json", 8 * 1024 * 1024)?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;
    validate_manifest_header(&manifest)?;
    validate_compression_profile(&entries, &manifest)?;
    let source_bytes = read_small(
        &mut archive,
        &manifest.source,
        limits.max_entry_bytes.min(64 * 1024 * 1024) as usize,
    )?;
    if sha256_hex(&source_bytes) != manifest.source_sha256 {
        return Err(format_error(
            "The document source failed its SHA-256 check.",
        ));
    }
    let source = String::from_utf8(source_bytes)
        .map_err(|_| format_error("document.nmt is not valid UTF-8."))?;
    let parsed = parse(&source);
    let document = parsed.document.clone().ok_or_else(|| {
        let first = parsed
            .diagnostics
            .first()
            .map(|item| format!("{}: {}", item.code, item.message))
            .unwrap_or_else(|| "invalid source".into());
        format_error(format!("Package source is invalid: {first}"))
    })?;

    let mut declared = BTreeSet::from([
        "mimetype".to_string(),
        "manifest.json".to_string(),
        manifest.source.clone(),
    ]);
    for (id, asset) in &manifest.assets {
        validate_asset_id(id)?;
        if asset.representations.is_empty() {
            return Err(format_error(format!("Asset {id} has no representations.")));
        }
        for representation in &asset.representations {
            validate_path(&representation.path)?;
            if !declared.insert(representation.path.clone()) {
                return Err(format_error(format!(
                    "Representation path {} is declared twice.",
                    representation.path
                )));
            }
            inspect_representation(&mut archive, id, representation)?;
        }
    }
    for entry in &entries {
        if !declared.contains(&entry.path) {
            return Err(format_error(format!(
                "Undeclared package entry {}.",
                entry.path
            )));
        }
    }

    let referenced = collect_asset_ids(&document);
    let packaged: BTreeSet<String> = manifest.assets.keys().cloned().collect();
    if referenced != packaged {
        let missing: Vec<_> = referenced.difference(&packaged).cloned().collect();
        let unused: Vec<_> = packaged.difference(&referenced).cloned().collect();
        return Err(format_error(format!(
            "Asset references do not match the manifest (missing: {}; unused: {}).",
            missing.join(", "),
            unused.join(", ")
        )));
    }

    let deferred_representations = manifest
        .assets
        .values()
        .map(|asset| asset.representations.len())
        .sum();
    Ok(OpenedPackage {
        path,
        manifest,
        source,
        document,
        diagnostics: parsed.diagnostics,
        entries,
        deferred_representations,
    })
}

/// Repack a package with new valid source while preserving verified asset bytes.
pub fn repack_to(
    package: &OpenedPackage,
    source: &str,
    target: impl AsRef<Path>,
) -> Result<PathBuf, PackageError> {
    let normalized = normalize_source(source);
    let parsed = parse(&normalized);
    let document = parsed.document.ok_or_else(|| {
        let message = parsed
            .diagnostics
            .first()
            .map(|item| format!("{}: {}", item.code, item.message))
            .unwrap_or_else(|| "invalid source".into());
        format_error(format!("Cannot save invalid source: {message}"))
    })?;
    let referenced = collect_asset_ids(&document);
    let packaged: BTreeSet<String> = package.manifest.assets.keys().cloned().collect();
    if referenced != packaged {
        return Err(format_error(
            "Cannot repack while source references and packaged assets differ.",
        ));
    }

    let target = target.as_ref().to_path_buf();
    if target.exists() {
        return Err(format_error(format!(
            "Refusing to overwrite existing file {}.",
            target.display()
        )));
    }
    let temp = temporary_sibling(&target);
    let result = write_repacked(
        package,
        &normalized,
        &package.manifest,
        &BTreeMap::new(),
        &temp,
    );
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    std::fs::rename(&temp, &target)?;
    Ok(target)
}

/// Repack with an explicit transaction of new and removed logical assets.
/// The resulting manifest must match source references exactly.
pub fn repack_with_asset_changes(
    package: &OpenedPackage,
    source: &str,
    additions: &[AssetInput],
    removals: &BTreeSet<String>,
    target: impl AsRef<Path>,
) -> Result<PathBuf, PackageError> {
    let normalized = normalize_source(source);
    let parsed = parse(&normalized);
    let document = parsed.document.ok_or_else(|| {
        let message = parsed
            .diagnostics
            .first()
            .map(|item| format!("{}: {}", item.code, item.message))
            .unwrap_or_else(|| "invalid source".into());
        format_error(format!("Cannot save invalid source: {message}"))
    })?;
    let referenced = collect_asset_ids(&document);
    for id in removals {
        if referenced.contains(id) {
            return Err(format_error(format!(
                "Cannot remove asset {id} while the source still references it."
            )));
        }
    }

    let mut manifest = package.manifest.clone();
    for id in removals {
        if manifest.assets.remove(id).is_none() {
            return Err(format_error(format!("Cannot remove unknown asset {id}.")));
        }
    }

    let mut added_sources = BTreeMap::new();
    let mut addition_ids = BTreeSet::new();
    for addition in additions {
        validate_asset_id(&addition.id)?;
        if !addition_ids.insert(addition.id.clone()) {
            return Err(format_error(format!(
                "Asset {} is staged twice.",
                addition.id
            )));
        }
        if manifest.assets.contains_key(&addition.id) {
            return Err(format_error(format!(
                "Asset {} already exists; remove it before replacing it.",
                addition.id
            )));
        }
        if !referenced.contains(&addition.id) {
            return Err(format_error(format!(
                "Added asset {} is not referenced by the source.",
                addition.id
            )));
        }
        let extension = asset_extension(&addition.path, &addition.media_type);
        let internal_path = format!("assets/{}{}", addition.id, extension);
        if manifest.assets.values().any(|asset| {
            asset
                .representations
                .iter()
                .any(|representation| representation.path == internal_path)
        }) {
            return Err(format_error(format!(
                "Asset path {internal_path} is already present."
            )));
        }
        let (bytes, digest) = hash_file(&addition.path)?;
        manifest.assets.insert(
            addition.id.clone(),
            ManifestAsset {
                kind: addition.kind.clone(),
                representations: vec![Representation {
                    path: internal_path.clone(),
                    media_type: addition.media_type.clone(),
                    role: addition.role.clone(),
                    bytes,
                    sha256: digest,
                }],
            },
        );
        added_sources.insert(internal_path, addition.path.clone());
    }

    let packaged: BTreeSet<String> = manifest.assets.keys().cloned().collect();
    if referenced != packaged {
        let missing: Vec<_> = referenced.difference(&packaged).cloned().collect();
        let unused: Vec<_> = packaged.difference(&referenced).cloned().collect();
        return Err(format_error(format!(
            "Asset transaction is incomplete (missing: {}; remove or reference: {}).",
            missing.join(", "),
            unused.join(", ")
        )));
    }

    let target = target.as_ref().to_path_buf();
    if target.exists() {
        return Err(format_error(format!(
            "Refusing to overwrite existing file {}.",
            target.display()
        )));
    }
    let temp = temporary_sibling(&target);
    let result = write_repacked(package, &normalized, &manifest, &added_sources, &temp);
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    std::fs::rename(&temp, &target)?;
    Ok(target)
}

/// Extract every representation of one verified logical asset without
/// overwriting existing files. Package-relative paths are preserved.
pub fn extract_asset(
    package: &OpenedPackage,
    asset_id: &str,
    target_directory: impl AsRef<Path>,
) -> Result<Vec<PathBuf>, PackageError> {
    let asset = package
        .manifest
        .assets
        .get(asset_id)
        .ok_or_else(|| format_error(format!("Unknown asset {asset_id}.")))?;
    let target_directory = target_directory.as_ref();
    let file = File::open(&package.path)?;
    let mut archive = ZipArchive::new(file)?;
    let mut extracted = Vec::new();
    for representation in &asset.representations {
        validate_path(&representation.path)?;
        let target = target_directory.join(&representation.path);
        if target.exists() {
            return Err(format_error(format!(
                "Refusing to overwrite existing file {}.",
                target.display()
            )));
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temp = temporary_sibling(&target);
        let mut output = File::create(&temp)?;
        if let Err(error) =
            copy_verified_representation(&mut archive, asset_id, representation, &mut output)
        {
            let _ = std::fs::remove_file(&temp);
            return Err(error);
        }
        output.sync_all()?;
        std::fs::rename(&temp, &target)?;
        extracted.push(target);
    }
    Ok(extracted)
}

/// Atomically unpack verified source, manifest, and asset representations into
/// a new directory. The mimetype transport marker is intentionally omitted.
pub fn extract_all(
    package: &OpenedPackage,
    target_directory: impl AsRef<Path>,
) -> Result<Vec<PathBuf>, PackageError> {
    let target_directory = target_directory.as_ref().to_path_buf();
    if target_directory.exists() {
        return Err(format_error(format!(
            "Refusing to overwrite existing path {}.",
            target_directory.display()
        )));
    }
    let temp = temporary_sibling(&target_directory);
    if temp.exists() {
        return Err(format_error(format!(
            "Temporary extraction path {} already exists.",
            temp.display()
        )));
    }

    let result = extract_all_into(package, &temp);
    let relative_paths = match result {
        Ok(paths) => paths,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&temp);
            return Err(error);
        }
    };
    std::fs::rename(&temp, &target_directory)?;
    Ok(relative_paths
        .into_iter()
        .map(|path| target_directory.join(path))
        .collect())
}

fn extract_all_into(package: &OpenedPackage, target: &Path) -> Result<Vec<PathBuf>, PackageError> {
    std::fs::create_dir_all(target)?;
    let mut paths = vec![
        PathBuf::from(&package.manifest.source),
        PathBuf::from("manifest.json"),
    ];
    for asset in package.manifest.assets.values() {
        for representation in &asset.representations {
            validate_path(&representation.path)?;
            paths.push(PathBuf::from(&representation.path));
        }
    }
    paths.sort();

    let file = File::open(&package.path)?;
    let mut archive = ZipArchive::new(file)?;
    let mut representations = BTreeMap::new();
    for (id, asset) in &package.manifest.assets {
        for representation in &asset.representations {
            representations.insert(representation.path.as_str(), (id.as_str(), representation));
        }
    }
    for relative in &paths {
        let path = relative
            .to_str()
            .ok_or_else(|| format_error("Package path is not UTF-8."))?;
        validate_path(path)?;
        let destination = target.join(relative);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut output = File::create(&destination)?;
        if path == "manifest.json" {
            let mut bytes = serde_json::to_vec_pretty(&package.manifest)?;
            bytes.push(b'\n');
            output.write_all(&bytes)?;
        } else if path == package.manifest.source {
            output.write_all(package.source.as_bytes())?;
        } else if let Some((id, representation)) = representations.get(path) {
            copy_verified_representation(&mut archive, id, representation, &mut output)?;
        } else {
            return Err(format_error(format!("Undeclared extraction path {path}.")));
        }
        output.sync_all()?;
    }
    Ok(paths)
}

fn write_new_package(
    source: &str,
    manifest: &Manifest,
    asset_sources: &BTreeMap<String, PathBuf>,
    target: &Path,
) -> Result<(), PackageError> {
    let output = File::create(target)?;
    let mut writer = ZipWriter::new(output);
    let manifest_bytes = canonical_json(manifest)?;
    let text_method = text_compression(manifest.container_profile);

    writer.start_file("mimetype", options(CompressionMethod::Stored))?;
    writer.write_all(MIMETYPE.as_bytes())?;
    writer.start_file("manifest.json", options(text_method))?;
    writer.write_all(&manifest_bytes)?;
    writer.start_file(&manifest.source, options(text_method))?;
    writer.write_all(source.as_bytes())?;
    for (id, asset) in &manifest.assets {
        for representation in &asset.representations {
            let method =
                representation_compression(manifest.container_profile, &representation.media_type);
            writer.start_file(&representation.path, options(method))?;
            let source_path = asset_sources.get(&representation.path).ok_or_else(|| {
                format_error(format!("Missing source for {}.", representation.path))
            })?;
            let mut input = File::open(source_path)?;
            copy_verified_reader(&mut input, id, representation, &mut writer)?;
        }
    }
    writer.finish()?.sync_all()?;
    force_utf8_flags(target)?;
    Ok(())
}

fn write_repacked(
    package: &OpenedPackage,
    source: &str,
    source_manifest: &Manifest,
    added_sources: &BTreeMap<String, PathBuf>,
    target: &Path,
) -> Result<(), PackageError> {
    let old_file = File::open(&package.path)?;
    let mut old_archive = ZipArchive::new(old_file)?;
    let output = File::create(target)?;
    let mut writer = ZipWriter::new(output);
    let mut manifest = source_manifest.clone();
    manifest.source_sha256 = sha256_hex(source.as_bytes());
    let manifest_bytes = canonical_json(&manifest)?;
    let text_method = text_compression(manifest.container_profile);

    writer.start_file("mimetype", options(CompressionMethod::Stored))?;
    writer.write_all(MIMETYPE.as_bytes())?;
    writer.start_file("manifest.json", options(text_method))?;
    writer.write_all(&manifest_bytes)?;
    writer.start_file(&manifest.source, options(text_method))?;
    writer.write_all(source.as_bytes())?;

    let mut representations: Vec<(&str, &Representation)> = manifest
        .assets
        .iter()
        .flat_map(|(id, asset)| {
            asset
                .representations
                .iter()
                .map(move |representation| (id.as_str(), representation))
        })
        .collect();
    representations.sort_by(|(_, a), (_, b)| {
        (&a.path, &a.role, &a.media_type).cmp(&(&b.path, &b.role, &b.media_type))
    });
    for (id, representation) in representations {
        let method =
            representation_compression(manifest.container_profile, &representation.media_type);
        writer.start_file(&representation.path, options(method))?;
        if let Some(source_path) = added_sources.get(&representation.path) {
            let mut input = File::open(source_path)?;
            copy_verified_reader(&mut input, id, representation, &mut writer)?;
        } else {
            copy_verified_representation(&mut old_archive, id, representation, &mut writer)?;
        }
    }
    writer.finish()?.sync_all()?;
    force_utf8_flags(target)?;
    Ok(())
}

/// `zip` correctly treats ASCII names as CP437-compatible and omits bit 11.
/// NotMarkdown canonical packages require the UTF-8 flag even for ASCII paths,
/// so set it in both header families after the archive has been finalized.
fn force_utf8_flags(path: &Path) -> Result<(), PackageError> {
    const LOCAL: u32 = 0x0403_4b50;
    const CENTRAL: u32 = 0x0201_4b50;
    const EOCD: u32 = 0x0605_4b50;
    const UTF8: u16 = 0x0800;

    let mut bytes = std::fs::read(path)?;
    let mut cursor = 0_usize;
    while cursor + 4 <= bytes.len() {
        let signature = little_u32(&bytes, cursor)?;
        match signature {
            LOCAL => {
                require_bytes(&bytes, cursor, 30)?;
                let flags = little_u16(&bytes, cursor + 6)? | UTF8;
                bytes[cursor + 6..cursor + 8].copy_from_slice(&flags.to_le_bytes());
                let packed = little_u32(&bytes, cursor + 18)? as usize;
                let name = little_u16(&bytes, cursor + 26)? as usize;
                let extra = little_u16(&bytes, cursor + 28)? as usize;
                cursor = cursor
                    .checked_add(30 + name + extra + packed)
                    .ok_or_else(|| format_error("ZIP offset overflow."))?;
            }
            CENTRAL => {
                require_bytes(&bytes, cursor, 46)?;
                let flags = little_u16(&bytes, cursor + 8)? | UTF8;
                bytes[cursor + 8..cursor + 10].copy_from_slice(&flags.to_le_bytes());
                let name = little_u16(&bytes, cursor + 28)? as usize;
                let extra = little_u16(&bytes, cursor + 30)? as usize;
                let comment = little_u16(&bytes, cursor + 32)? as usize;
                cursor = cursor
                    .checked_add(46 + name + extra + comment)
                    .ok_or_else(|| format_error("ZIP offset overflow."))?;
            }
            EOCD => break,
            _ => {
                return Err(format_error(format!(
                    "Unexpected ZIP record at byte {cursor}."
                )));
            }
        }
    }
    let mut file = OpenOptions::new().write(true).truncate(true).open(path)?;
    file.seek(SeekFrom::Start(0))?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(())
}

fn require_bytes(bytes: &[u8], offset: usize, length: usize) -> Result<(), PackageError> {
    if offset
        .checked_add(length)
        .is_some_and(|end| end <= bytes.len())
    {
        Ok(())
    } else {
        Err(format_error("Truncated ZIP record."))
    }
}

fn little_u16(bytes: &[u8], offset: usize) -> Result<u16, PackageError> {
    require_bytes(bytes, offset, 2)?;
    Ok(u16::from_le_bytes([bytes[offset], bytes[offset + 1]]))
}

fn little_u32(bytes: &[u8], offset: usize) -> Result<u32, PackageError> {
    require_bytes(bytes, offset, 4)?;
    Ok(u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ]))
}

fn options(method: CompressionMethod) -> SimpleFileOptions {
    let level = match method {
        CompressionMethod::Deflated => Some(9),
        CompressionMethod::Zstd => Some(10),
        _ => None,
    };
    SimpleFileOptions::default()
        .compression_method(method)
        .compression_level(level)
        .last_modified_time(DateTime::default())
        .unix_permissions(0o644)
}

fn canonical_json(manifest: &Manifest) -> Result<Vec<u8>, PackageError> {
    let mut output = serde_json::to_vec(manifest)?;
    output.push(b'\n');
    Ok(output)
}

fn read_small<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    path: &str,
    limit: usize,
) -> Result<Vec<u8>, PackageError> {
    let mut entry = archive
        .by_name(path)
        .map_err(|_| format_error(format!("Required entry {path} is missing.")))?;
    if entry.size() > limit as u64 {
        return Err(format_error(format!(
            "Entry {path} exceeds its size limit."
        )));
    }
    let mut output = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut output)?;
    Ok(output)
}

fn inspect_representation<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    id: &str,
    representation: &Representation,
) -> Result<(), PackageError> {
    let entry = archive.by_name(&representation.path).map_err(|_| {
        format_error(format!(
            "Asset {id} is missing representation {}.",
            representation.path
        ))
    })?;
    if entry.size() != representation.bytes {
        return Err(format_error(format!(
            "Asset {id} has the wrong byte length."
        )));
    }
    Ok(())
}

fn verify_representation_bytes(
    id: &str,
    representation: &Representation,
    bytes: &[u8],
) -> Result<(), PackageError> {
    if bytes.len() as u64 != representation.bytes {
        return Err(format_error(format!(
            "Asset {id} has the wrong byte length."
        )));
    }
    if sha256_hex(bytes) != representation.sha256 {
        return Err(format_error(format!(
            "Asset {id} failed its SHA-256 check."
        )));
    }
    Ok(())
}

fn copy_verified_representation<R: Read + Seek, W: Write>(
    archive: &mut ZipArchive<R>,
    id: &str,
    representation: &Representation,
    output: &mut W,
) -> Result<u64, PackageError> {
    let mut entry = archive.by_name(&representation.path).map_err(|_| {
        format_error(format!(
            "Asset {id} is missing representation {}.",
            representation.path
        ))
    })?;
    if entry.size() != representation.bytes {
        return Err(format_error(format!(
            "Asset {id} has the wrong byte length."
        )));
    }
    copy_verified_reader(&mut entry, id, representation, output)
}

fn copy_verified_reader<R: Read, W: Write>(
    input: &mut R,
    id: &str,
    representation: &Representation,
    output: &mut W,
) -> Result<u64, PackageError> {
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| format_error("Representation size overflow."))?;
        if total > representation.bytes {
            return Err(format_error(format!(
                "Asset {id} has the wrong byte length."
            )));
        }
        digest.update(&buffer[..read]);
        output.write_all(&buffer[..read])?;
    }
    if total != representation.bytes || hex(&digest.finalize()) != representation.sha256 {
        return Err(format_error(format!(
            "Asset {id} failed its SHA-256 check."
        )));
    }
    Ok(total)
}

struct DigestWriter<'a>(&'a mut Sha256);

impl Write for DigestWriter<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0.update(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn digest_writer(digest: &mut Sha256) -> DigestWriter<'_> {
    DigestWriter(digest)
}

fn validate_manifest_header(manifest: &Manifest) -> Result<(), PackageError> {
    if manifest.format != "notmarkdown"
        || manifest.package_version != "0.1"
        || manifest.source != "document.nmt"
        || manifest.theme_profile != "0.1"
    {
        return Err(format_error("Unsupported or invalid NotMarkdown manifest."));
    }
    if manifest.source_sha256.len() != 64
        || !manifest
            .source_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(format_error("Invalid source SHA-256 value."));
    }
    Ok(())
}

fn validate_path(path: &str) -> Result<(), PackageError> {
    if path.is_empty()
        || path.starts_with('/')
        || path.ends_with('/')
        || path.contains('\\')
        || path
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return Err(format_error(format!("Unsafe package path {path}.")));
    }
    Ok(())
}

fn validate_asset_id(id: &str) -> Result<(), PackageError> {
    let valid = id
        .bytes()
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if valid {
        Ok(())
    } else {
        Err(format_error(format!("Invalid asset ID {id}.")))
    }
}

fn compression_name(method: CompressionMethod) -> &'static str {
    match method {
        CompressionMethod::Stored => "store",
        CompressionMethod::Deflated => "deflate",
        CompressionMethod::Zstd => "zstd",
        _ => "unsupported",
    }
}

fn text_compression(profile: ContainerProfile) -> CompressionMethod {
    match profile {
        ContainerProfile::Modern => CompressionMethod::Zstd,
        ContainerProfile::Portable => CompressionMethod::Deflated,
    }
}

fn representation_compression(profile: ContainerProfile, media_type: &str) -> CompressionMethod {
    if compressible(media_type) {
        text_compression(profile)
    } else {
        CompressionMethod::Stored
    }
}

fn validate_compression_profile(
    entries: &[EntryInfo],
    manifest: &Manifest,
) -> Result<(), PackageError> {
    let expected_text = compression_name(text_compression(manifest.container_profile));
    for path in ["manifest.json", manifest.source.as_str()] {
        let entry = entries
            .iter()
            .find(|entry| entry.path == path)
            .ok_or_else(|| format_error(format!("Required entry {path} is missing.")))?;
        if entry.compression != expected_text {
            return Err(format_error(format!(
                "Entry {path} violates the {} compression profile.",
                manifest.container_profile
            )));
        }
    }
    for asset in manifest.assets.values() {
        for representation in &asset.representations {
            let entry = entries
                .iter()
                .find(|entry| entry.path == representation.path)
                .ok_or_else(|| {
                    format_error(format!(
                        "Required entry {} is missing.",
                        representation.path
                    ))
                })?;
            let expected = compression_name(representation_compression(
                manifest.container_profile,
                &representation.media_type,
            ));
            if entry.compression != expected {
                return Err(format_error(format!(
                    "Entry {} violates the {} compression profile.",
                    representation.path, manifest.container_profile
                )));
            }
        }
    }
    Ok(())
}

fn compressible(media_type: &str) -> bool {
    media_type.starts_with("text/")
        || matches!(
            media_type,
            "application/json"
                | "application/xml"
                | "application/yaml"
                | "application/vnd.jgraph.mxfile"
                | "image/svg+xml"
        )
        || is_vega_lite_media_type(media_type)
}

fn infer_media_type(path: &Path) -> &'static str {
    let file_name = path
        .file_name()
        .and_then(|item| item.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if file_name.ends_with(".drawio.svg") {
        return "image/svg+xml";
    }
    if file_name.ends_with(".vl.json") || file_name.ends_with(".vegalite.json") {
        return "application/vnd.vegalite+json";
    }

    match path
        .extension()
        .and_then(|item| item.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "avif" => "image/avif",
        "webp" => "image/webp",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "opus" | "ogg" => "audio/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "webm" => "video/webm",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "vtt" => "text/vtt",
        "md" | "markdown" => "text/markdown",
        "mmd" | "mermaid" => "text/vnd.mermaid",
        "drawio" | "dio" => "application/vnd.jgraph.mxfile",
        "json" => "application/json",
        "csv" => "text/csv",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}

fn infer_kind(path: &Path, media_type: &str) -> &'static str {
    let file_name = path
        .file_name()
        .and_then(|item| item.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if file_name.ends_with(".drawio.svg")
        || matches!(
            media_type,
            "text/vnd.mermaid" | "application/vnd.jgraph.mxfile"
        )
    {
        "diagram"
    } else if media_type.starts_with("image/") {
        "image"
    } else if media_type.starts_with("audio/") {
        "audio"
    } else if media_type.starts_with("video/") {
        "video"
    } else if matches!(media_type, "application/json" | "text/csv")
        || is_vega_lite_media_type(media_type)
    {
        "data"
    } else {
        "attachment"
    }
}

fn infer_role(kind: &str) -> &'static str {
    match kind {
        "image" | "audio" | "video" => "playback",
        "data" => "data",
        "diagram" => "source",
        _ => "original",
    }
}

fn asset_extension(path: &Path, media_type: &str) -> String {
    let file_name = path
        .file_name()
        .and_then(|item| item.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    for suffix in [".drawio.svg", ".vegalite.json", ".vl.json"] {
        if file_name.ends_with(suffix) {
            return suffix.into();
        }
    }

    let extension = path
        .extension()
        .and_then(|item| item.to_str())
        .filter(|item| {
            !item.is_empty()
                && item.len() <= 12
                && item.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
        .map(|item| format!(".{}", item.to_ascii_lowercase()));
    extension.unwrap_or_else(|| match media_type {
        "image/avif" => ".avif".into(),
        "image/webp" => ".webp".into(),
        "image/svg+xml" => ".svg".into(),
        "audio/ogg" => ".opus".into(),
        "video/webm" => ".webm".into(),
        "video/mp4" => ".mp4".into(),
        "text/vtt" => ".vtt".into(),
        "text/vnd.mermaid" => ".mmd".into(),
        "application/vnd.jgraph.mxfile" => ".drawio".into(),
        "application/json" => ".json".into(),
        "application/pdf" => ".pdf".into(),
        _ if is_vega_lite_media_type(media_type) => ".vl.json".into(),
        _ => ".bin".into(),
    })
}

fn is_vega_lite_media_type(media_type: &str) -> bool {
    matches!(
        media_type,
        "application/vnd.vegalite+json"
            | "application/vnd.vegalite.v5+json"
            | "application/vnd.vegalite.v6+json"
    )
}

fn hash_file(path: &Path) -> Result<(u64, String), PackageError> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let bytes = io::copy(&mut file, &mut digest_writer(&mut digest))?;
    Ok((bytes, hex(&digest.finalize())))
}

fn normalize_source(source: &str) -> String {
    let mut output = source.replace("\r\n", "\n").replace('\r', "\n");
    while output.ends_with('\n') {
        output.pop();
    }
    output.push('\n');
    output
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}

fn temporary_sibling(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .and_then(|item| item.to_str())
        .unwrap_or("document.nmdoc");
    target.with_file_name(format!(".{name}.tmp-{}", std::process::id()))
}

fn format_error(message: impl Into<String>) -> PackageError {
    PackageError::Format(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn example_path() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../NotMarkdown-example-modern-0.1.nmdoc")
    }

    #[test]
    fn infers_static_visual_asset_metadata_from_file_names() {
        let directory = std::env::temp_dir().join(format!(
            "notmarkdown-rust-static-visual-assets-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("create fixture directory");

        let cases = [
            ("flow.MMD", "text/vnd.mermaid", "diagram", "source"),
            ("flow.mermaid", "text/vnd.mermaid", "diagram", "source"),
            (
                "architecture.drawio",
                "application/vnd.jgraph.mxfile",
                "diagram",
                "source",
            ),
            (
                "architecture.dio",
                "application/vnd.jgraph.mxfile",
                "diagram",
                "source",
            ),
            (
                "architecture.DRAWIO.SVG",
                "image/svg+xml",
                "diagram",
                "source",
            ),
            (
                "latency.vl.json",
                "application/vnd.vegalite+json",
                "data",
                "data",
            ),
            (
                "latency.VEGALITE.JSON",
                "application/vnd.vegalite+json",
                "data",
                "data",
            ),
        ];

        for (name, media_type, kind, role) in cases {
            let path = directory.join(name);
            std::fs::write(&path, b"").expect("write fixture");
            let input = AssetInput::from_path("visual", &path).expect("infer asset metadata");
            assert_eq!(input.media_type, media_type, "media type for {name}");
            assert_eq!(input.kind, kind, "kind for {name}");
            assert_eq!(input.role, role, "role for {name}");
        }

        std::fs::remove_dir_all(directory).expect("remove fixture directory");
    }

    #[test]
    fn preserves_compound_visual_suffixes_deterministically() {
        assert_eq!(
            asset_extension(Path::new("Architecture.DRAWIO.SVG"), "image/svg+xml"),
            ".drawio.svg"
        );
        assert_eq!(
            asset_extension(
                Path::new("Latency.VEGALITE.JSON"),
                "application/vnd.vegalite+json"
            ),
            ".vegalite.json"
        );
        assert_eq!(
            asset_extension(
                Path::new("Latency.VL.JSON"),
                "application/vnd.vegalite+json"
            ),
            ".vl.json"
        );
    }

    #[test]
    fn accepts_current_vega_lite_mime_aliases_as_data() {
        for media_type in [
            "application/vnd.vegalite+json",
            "application/vnd.vegalite.v5+json",
            "application/vnd.vegalite.v6+json",
        ] {
            assert_eq!(infer_kind(Path::new("chart.bin"), media_type), "data");
            assert_eq!(infer_role("data"), "data");
            assert!(compressible(media_type));
            assert_eq!(asset_extension(Path::new("chart"), media_type), ".vl.json");
        }
    }

    #[test]
    fn opens_the_node_generated_modern_fixture() {
        let opened = open(example_path()).expect("open Node fixture");
        assert_eq!(opened.manifest.container_profile, ContainerProfile::Modern);
        assert!(opened.manifest.assets.contains_key("package-flow"));
        assert!(opened.source.contains("asset:package-flow"));
        assert_eq!(opened.deferred_representations, 1);
        assert_eq!(verify_all(&opened).expect("verify deferred asset"), 1);
        assert!(
            opened
                .entries
                .iter()
                .any(|entry| entry.compression == "zstd")
        );
    }

    #[test]
    fn bounded_representation_reads_verify_bytes_and_enforce_the_caller_limit() {
        let opened = open(example_path()).expect("open Node fixture");
        let representation = &opened.manifest.assets["package-flow"].representations[0];
        let bytes = read_asset_representation(
            &opened,
            "package-flow",
            &representation.path,
            usize::try_from(representation.bytes).expect("fixture size"),
        )
        .expect("read verified representation");
        assert_eq!(bytes.len() as u64, representation.bytes);
        assert!(
            read_asset_representation(&opened, "package-flow", &representation.path, 1).is_err()
        );
        assert!(
            read_asset_representation(&opened, "package-flow", "assets/missing.svg", 1024).is_err()
        );
    }

    #[test]
    fn repack_is_readable_and_preserves_assets() {
        let opened = open(example_path()).expect("open fixture");
        let output = std::env::temp_dir().join(format!(
            "notmarkdown-rust-repack-{}.nmdoc",
            std::process::id()
        ));
        let second = std::env::temp_dir().join(format!(
            "notmarkdown-rust-repack-second-{}.nmdoc",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&output);
        let _ = std::fs::remove_file(&second);
        let source = opened.source.replace("A packaged diagram", "A Rust repack");
        repack_to(&opened, &source, &output).expect("repack");
        repack_to(&opened, &source, &second).expect("second repack");
        assert_eq!(
            std::fs::read(&output).expect("first bytes"),
            std::fs::read(&second).expect("second bytes")
        );
        let reparsed = open(&output).expect("open repack");
        assert!(reparsed.source.contains("A Rust repack"));
        assert_eq!(reparsed.manifest.assets, opened.manifest.assets);

        let node_cli = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../notmarkdown-reference-parser/dist/cli.js");
        let status = Command::new("node")
            .arg(node_cli)
            .arg("inspect")
            .arg(&output)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("run Node reference reader");
        assert!(status.success(), "Node reader rejected Rust package");
        std::fs::remove_file(output).expect("remove fixture");
        std::fs::remove_file(second).expect("remove second fixture");
    }

    #[test]
    fn enforces_entry_limits_before_expansion() {
        let limits = ReadLimits {
            max_entries: 2,
            ..ReadLimits::default()
        };
        let error = open_with_limits(example_path(), &limits).expect_err("limit failure");
        assert!(error.to_string().contains("too many entries"));
    }

    #[test]
    fn defers_corrupt_binary_payload_until_verified_access() {
        let asset_path = std::env::temp_dir().join(format!(
            "notmarkdown-rust-lazy-asset-{}.bin",
            std::process::id()
        ));
        let package_path = std::env::temp_dir().join(format!(
            "notmarkdown-rust-lazy-package-{}.nmdoc",
            std::process::id()
        ));
        let extraction = std::env::temp_dir().join(format!(
            "notmarkdown-rust-lazy-extract-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&asset_path);
        let _ = std::fs::remove_file(&package_path);
        let _ = std::fs::remove_dir_all(&extraction);
        let bytes: Vec<u8> = (0_u32..4096)
            .flat_map(|value| value.to_le_bytes())
            .collect();
        std::fs::write(&asset_path, &bytes).expect("write binary asset");
        let asset = AssetInput::from_path("payload", &asset_path).expect("asset input");
        let source = "@notmarkdown 0.1\n\n# Deferred integrity\n\n![Payload](asset:payload)\n";
        create_package(source, &[asset], ContainerProfile::Portable, &package_path)
            .expect("create package");

        let mut package_bytes = std::fs::read(&package_path).expect("package bytes");
        let offset = package_bytes
            .windows(bytes.len())
            .position(|window| window == bytes)
            .expect("stored payload range");
        package_bytes[offset + 123] ^= 0xff;
        std::fs::write(&package_path, package_bytes).expect("damage payload");

        let opened = open(&package_path).expect("metadata-first open");
        assert_eq!(opened.deferred_representations, 1);
        assert!(verify_all(&opened).is_err());
        assert!(extract_asset(&opened, "payload", &extraction).is_err());
        assert!(!extraction.join("assets/payload.bin").exists());

        std::fs::remove_file(asset_path).expect("remove asset");
        std::fs::remove_file(package_path).expect("remove package");
        let _ = std::fs::remove_dir_all(extraction);
    }

    #[test]
    fn extracts_a_verified_asset_without_flattening_paths() {
        let opened = open(example_path()).expect("open fixture");
        let directory =
            std::env::temp_dir().join(format!("notmarkdown-rust-extract-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        let paths = extract_asset(&opened, "package-flow", &directory).expect("extract");
        assert_eq!(paths.len(), 1);
        assert!(paths[0].ends_with("assets/package-flow.svg"));
        assert_eq!(std::fs::read(&paths[0]).expect("asset bytes").len(), 733);
        let error = extract_asset(&opened, "package-flow", &directory).expect_err("overwrite");
        assert!(error.to_string().contains("Refusing to overwrite"));
        std::fs::remove_dir_all(directory).expect("remove extraction fixture");
    }

    #[test]
    fn transaction_replaces_an_asset_and_remains_node_readable() {
        let opened = open(example_path()).expect("open fixture");
        let asset_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../notmarkdown-reference-parser/examples/package-flow.svg");
        let addition = AssetInput::from_path("new-flow", asset_path).expect("asset input");
        let source = opened
            .source
            .replace("asset:package-flow", "asset:new-flow");
        let removals = BTreeSet::from(["package-flow".to_string()]);
        let first = std::env::temp_dir().join(format!(
            "notmarkdown-rust-assets-{}.nmdoc",
            std::process::id()
        ));
        let second = std::env::temp_dir().join(format!(
            "notmarkdown-rust-assets-second-{}.nmdoc",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&first);
        let _ = std::fs::remove_file(&second);
        repack_with_asset_changes(
            &opened,
            &source,
            std::slice::from_ref(&addition),
            &removals,
            &first,
        )
        .expect("first transaction");
        repack_with_asset_changes(&opened, &source, &[addition], &removals, &second)
            .expect("second transaction");
        assert_eq!(
            std::fs::read(&first).expect("first bytes"),
            std::fs::read(&second).expect("second bytes")
        );
        let changed = open(&first).expect("open changed package");
        assert!(changed.manifest.assets.contains_key("new-flow"));
        assert!(!changed.manifest.assets.contains_key("package-flow"));
        assert_eq!(
            changed.manifest.assets["new-flow"].representations[0].media_type,
            "image/svg+xml"
        );

        let node_cli = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../notmarkdown-reference-parser/dist/cli.js");
        let status = Command::new("node")
            .arg(node_cli)
            .arg("inspect")
            .arg(&first)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("run Node reader");
        assert!(status.success(), "Node rejected mutated package");
        std::fs::remove_file(first).expect("remove first");
        std::fs::remove_file(second).expect("remove second");
    }

    #[test]
    fn transaction_rejects_referenced_removals_and_unused_additions() {
        let opened = open(example_path()).expect("open fixture");
        let target = std::env::temp_dir().join(format!(
            "notmarkdown-rust-invalid-assets-{}.nmdoc",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&target);
        let removals = BTreeSet::from(["package-flow".to_string()]);
        let error = repack_with_asset_changes(&opened, &opened.source, &[], &removals, &target)
            .expect_err("referenced removal");
        assert!(error.to_string().contains("still references"));

        let asset_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../notmarkdown-reference-parser/examples/package-flow.svg");
        let addition = AssetInput::from_path("unused", asset_path).expect("asset input");
        let error = repack_with_asset_changes(
            &opened,
            &opened.source,
            &[addition],
            &BTreeSet::new(),
            &target,
        )
        .expect_err("unused addition");
        assert!(error.to_string().contains("not referenced"));
    }

    #[test]
    fn creates_deterministic_loose_packages_readable_by_node() {
        let source_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../notmarkdown-reference-parser/examples/package.nmt");
        let asset_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../notmarkdown-reference-parser/examples/package-flow.svg");
        let source = std::fs::read_to_string(source_path).expect("source fixture");
        let asset = AssetInput::from_path("package-flow", asset_path).expect("asset input");
        let first = std::env::temp_dir().join(format!(
            "notmarkdown-rust-create-{}.nmdoc",
            std::process::id()
        ));
        let second = std::env::temp_dir().join(format!(
            "notmarkdown-rust-create-second-{}.nmdoc",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&first);
        let _ = std::fs::remove_file(&second);

        create_package(
            &source,
            std::slice::from_ref(&asset),
            ContainerProfile::Modern,
            &first,
        )
        .expect("create first");
        create_package(&source, &[asset], ContainerProfile::Modern, &second)
            .expect("create second");
        assert_eq!(
            std::fs::read(&first).expect("first bytes"),
            std::fs::read(&second).expect("second bytes")
        );
        let opened = open(&first).expect("open created package");
        assert_eq!(opened.manifest.container_profile, ContainerProfile::Modern);

        let node_cli = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../notmarkdown-reference-parser/dist/cli.js");
        let status = Command::new("node")
            .arg(node_cli)
            .arg("inspect")
            .arg(&first)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("run Node reader");
        assert!(status.success(), "Node rejected Rust-created package");
        std::fs::remove_file(first).expect("remove first");
        std::fs::remove_file(second).expect("remove second");
    }

    #[test]
    fn package_index_reads_verified_captions_transcript_and_attachment_text() {
        let examples = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../notmarkdown-reference-parser/examples");
        let source = std::fs::read_to_string(examples.join("search-package.nmt")).expect("source");
        let assets = [
            ("search-demo", "search-demo.webm"),
            ("search-captions", "search-captions.vtt"),
            ("search-transcript", "search-transcript.txt"),
            ("search-notes", "search-notes.md"),
        ]
        .into_iter()
        .map(|(id, file)| AssetInput::from_path(id, examples.join(file)).expect("asset"))
        .collect::<Vec<_>>();
        let target = std::env::temp_dir().join(format!(
            "notmarkdown-rust-search-assets-{}.nmdoc",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&target);
        create_package(&source, &assets, ContainerProfile::Portable, &target)
            .expect("create searchable package");
        let package = open(&target).expect("open searchable package");
        let mut cache = IncrementalSearchCache::default();
        let first = update_package_search_cache(
            &mut cache,
            &package,
            &package.document,
            &package.manifest.source_sha256,
        )
        .expect("build package index");
        assert_eq!(first.stats.assets_reindexed, 3);
        assert_eq!(first.stats.assets_reused, 0);
        let second = update_package_search_cache(
            &mut cache,
            &package,
            &package.document,
            &package.manifest.source_sha256,
        )
        .expect("reuse package index");
        assert!(second.stats.document_reused);
        assert_eq!(second.stats.assets_reindexed, 0);
        assert_eq!(second.stats.assets_reused, 3);
        let index = second.index;
        assert_eq!(index.index_version, "0.2");
        assert!(index.omissions.is_empty());
        let captions = notmarkdown_core::search_index(&index, "spoken captions", 10);
        assert_eq!(captions[0].asset_id.as_deref(), Some("search-captions"));
        assert_eq!(captions[0].kind, "captions");
        let transcript = notmarkdown_core::search_index(&index, "silent magnetic", 10);
        assert_eq!(transcript[0].asset_id.as_deref(), Some("search-transcript"));
        let notes = notmarkdown_core::search_index(&index, "tidal-cycle", 10);
        assert_eq!(notes[0].kind, "attachmentText");
        std::fs::remove_file(target).expect("remove searchable package");
    }

    #[test]
    fn unpacks_a_verified_package_atomically_without_overwrite() {
        let opened = open(example_path()).expect("open fixture");
        let directory =
            std::env::temp_dir().join(format!("notmarkdown-rust-unpack-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        let paths = extract_all(&opened, &directory).expect("unpack package");
        assert!(paths.iter().any(|path| path.ends_with("document.nmt")));
        assert!(
            paths
                .iter()
                .any(|path| path.ends_with("assets/package-flow.svg"))
        );
        assert_eq!(
            std::fs::read_to_string(directory.join("document.nmt")).expect("source"),
            opened.source
        );
        let manifest: Manifest = serde_json::from_slice(
            &std::fs::read(directory.join("manifest.json")).expect("manifest"),
        )
        .expect("manifest JSON");
        assert_eq!(manifest.source_sha256, opened.manifest.source_sha256);
        let error = extract_all(&opened, &directory).expect_err("overwrite refusal");
        assert!(error.to_string().contains("Refusing to overwrite"));
        std::fs::remove_dir_all(directory).expect("remove unpacked fixture");
    }
}
