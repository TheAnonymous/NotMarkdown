package org.notmarkdown.intellij

import com.intellij.icons.AllIcons
import com.intellij.lang.Language
import com.intellij.openapi.fileTypes.FileType
import com.intellij.openapi.fileTypes.LanguageFileType
import javax.swing.Icon

object NotMarkdownLanguage : Language("NotMarkdown")

class NotMarkdownFileType private constructor() : LanguageFileType(NotMarkdownLanguage) {
    override fun getName() = "NotMarkdown Source"
    override fun getDescription() = "Human-readable NotMarkdown source"
    override fun getDefaultExtension() = "nmt"
    override fun getIcon(): Icon = AllIcons.FileTypes.Text

    companion object {
        @JvmField
        val INSTANCE = NotMarkdownFileType()
    }
}

class NotMarkdownPackageFileType private constructor() : FileType {
    override fun getName() = "NotMarkdown Package"
    override fun getDescription() = "Portable NotMarkdown document package"
    override fun getDefaultExtension() = "nmdoc"
    override fun getIcon(): Icon = AllIcons.FileTypes.Archive
    override fun isBinary() = true
    override fun isReadOnly() = false
    override fun getCharset(file: com.intellij.openapi.vfs.VirtualFile, content: ByteArray) = null

    companion object {
        @JvmField
        val INSTANCE = NotMarkdownPackageFileType()
    }
}
