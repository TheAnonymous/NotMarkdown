package org.notmarkdown.intellij

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.LspServerSupportProvider
import com.intellij.platform.lsp.api.ProjectWideLspServerDescriptor

class NotMarkdownLspServerSupportProvider : LspServerSupportProvider {
    override fun fileOpened(
        project: Project,
        file: VirtualFile,
        serverStarter: LspServerSupportProvider.LspServerStarter,
    ) {
        if (file.extension.equals("nmt", ignoreCase = true)) {
            serverStarter.ensureServerStarted(NotMarkdownLspServerDescriptor(project))
        }
    }
}

private class NotMarkdownLspServerDescriptor(project: Project) :
    ProjectWideLspServerDescriptor(project, "NotMarkdown") {
    override fun isSupportedFile(file: VirtualFile) =
        file.extension.equals("nmt", ignoreCase = true)

    override fun createCommandLine(): GeneralCommandLine =
        GeneralCommandLine(
            System.getenv("NOTMARKDOWN_LSP")?.takeIf(String::isNotBlank)
                ?: "notmarkdown-lsp",
            "--stdio",
        )
}
