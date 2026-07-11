package org.notmarkdown.intellij

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.CapturingProcessHandler
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.ui.Messages

abstract class NotMarkdownPackageAction(
    private val subcommand: String,
    text: String,
) : AnAction(text) {
    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible =
            event.getData(CommonDataKeys.VIRTUAL_FILE)
                ?.extension
                .equals("nmdoc", ignoreCase = true)
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        val title = templatePresentation.text
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, title, true) {
            private var output = ""
            private var failure: String? = null

            override fun run(indicator: ProgressIndicator) {
                indicator.text = "$title · ${file.name}"
                val tool = System.getenv("NOTMARKDOWN_TOOL")
                    ?.takeIf(String::isNotBlank)
                    ?: "notmarkdown"
                val result = CapturingProcessHandler(
                    GeneralCommandLine(tool, subcommand, "--compact", file.path)
                ).runProcess(60_000)
                output = result.stdout.trim()
                if (result.exitCode != 0) {
                    failure = result.stderr.trim().ifBlank { "NotMarkdown command failed." }
                }
            }

            override fun onSuccess() {
                val error = failure
                if (error == null) {
                    Messages.showInfoMessage(project, output, title)
                } else {
                    Messages.showErrorDialog(project, error, title)
                }
            }
        })
    }
}

class InspectPackageAction : NotMarkdownPackageAction("inspect", "Inspect NotMarkdown Package")

class VerifyPackageAction :
    NotMarkdownPackageAction("verify", "Verify Complete NotMarkdown Package")
