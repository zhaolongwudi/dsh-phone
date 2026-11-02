package com.dshphone

import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class PhoneJetHubAliasTest {
    private fun root() = Files.createTempDirectory("jethub-名称 空格-").toFile()
    private fun install(root: File, current: Boolean = true): List<File> {
        return listOf("tree/node_modules", "dsh-home/profiles/phone/node_modules").map {
            val modules = File(root, it).apply { mkdirs() }
            File(modules, "dsh-codearts-auth").mkdirs()
            File(modules, "dsh-codearts-auth/package.json").writeText(
                """{"name":"${if (current) "dsh-providers-hub" else "dsh-codearts-auth"}","version":"test"}""")
            modules
        }
    }
    private fun writeHub(modules: File) {
        File(modules, "dsh-providers-hub").mkdirs()
        File(modules, "dsh-providers-hub/package.json").writeText(
            """{"name":"dsh-providers-hub","version":"0.2.1-rc.2"}""")
    }
    /** 复现 2026-11-02 新包布局：随包直接投放 dsh-providers-hub 实体，不带旧名目录。 */
    private fun shippedLayout(root: File): List<File> =
        listOf("tree/node_modules", "dsh-home/profiles/phone/node_modules").map {
            val modules = File(root, it).apply { mkdirs() }
            writeHub(modules)
            modules
        }

    @Test fun namesResolveToOnePhysicalPackageAndRepeatedPreparationIsSafe() {
        val root = root(); val modules = install(root)
        PhoneJetHubAlias.prepare(root); PhoneJetHubAlias.prepare(root)
        for (dir in modules) assertEquals(File(dir,"dsh-codearts-auth").canonicalFile,
            File(dir,"dsh-providers-hub").canonicalFile)
    }
    @Test fun independentSameNameIsRejectedBeforeWritingEitherAliasAndRecoveryCanRetry() {
        val root=root(); val modules=install(root)
        val conflict=File(modules[1],"dsh-providers-hub").apply{mkdirs()}
        File(conflict,"user.txt").writeText("keep")
        assertTrue(runCatching { PhoneJetHubAlias.prepare(root) }.isFailure)
        assertFalse(Files.exists(File(modules[0],"dsh-providers-hub").toPath(),java.nio.file.LinkOption.NOFOLLOW_LINKS))
        assertEquals("keep",File(conflict,"user.txt").readText())
        File(conflict,"user.txt").delete(); conflict.delete()
        PhoneJetHubAlias.prepare(root)
        assertTrue(Files.isSymbolicLink(File(modules[0],"dsh-providers-hub").toPath()))
    }
    @Test fun unrelatedAndBrokenSymlinksAreRejectedWithoutTouchingTheirTargets() {
        val root=root();val modules=install(root)
        Files.createSymbolicLink(File(modules[0],"dsh-providers-hub").toPath(),File("unrelated").toPath())
        assertTrue(runCatching { PhoneJetHubAlias.preflight(root) }.isFailure)
        assertEquals("unrelated",Files.readSymbolicLink(File(modules[0],"dsh-providers-hub").toPath()).toString())
    }
    @Test fun olderUnrenamedPackageDoesNotGainANewRegistration() {
        val root=root();val modules=install(root,false)
        PhoneJetHubAlias.prepare(root)
        for(dir in modules) assertFalse(Files.exists(File(dir,"dsh-providers-hub").toPath(),java.nio.file.LinkOption.NOFOLLOW_LINKS))
    }

    /** 新装：随包只有 dsh-providers-hub 实体，启动必须放行且不新建旧名目录。 */
    @Test fun shippedCurrentOnlyLayoutIsAcceptedAndStaysSymlinkFree() {
        val root=root();val modules=shippedLayout(root)
        PhoneJetHubAlias.preflight(root)
        PhoneJetHubAlias.prepare(root)
        for(dir in modules){
            assertFalse(Files.isSymbolicLink(File(dir,"dsh-providers-hub").toPath()))
            assertFalse(Files.exists(File(dir,"dsh-codearts-auth").toPath(),java.nio.file.LinkOption.NOFOLLOW_LINKS))
        }
    }

    /** 覆盖升级：旧实体残留在新实体旁时以新实体为准，不阻塞启动、不删旧目录。 */
    @Test fun upgradeLeavingLegacyEntityBesideShippedOneIsAcceptedWithoutDeleting() {
        val root=root();val modules=install(root)
        for(dir in modules) writeHub(dir)
        PhoneJetHubAlias.prepare(root)
        for(dir in modules){
            assertTrue(File(dir,"dsh-codearts-auth/package.json").isFile)
            assertTrue(File(dir,"dsh-providers-hub/package.json").isFile)
            assertFalse(Files.isSymbolicLink(File(dir,"dsh-providers-hub").toPath()))
        }
    }

    /** 同名目录被无关内容占住时必须拒绝，且不改动原文件。 */
    @Test fun foreignDirectoryUnderCurrentNameIsRejectedAndPreserved() {
        val root=root();val modules=shippedLayout(root)
        File(modules[0],"dsh-providers-hub/package.json").delete()
        File(modules[0],"dsh-providers-hub/other.txt").writeText("keep")
        assertTrue(runCatching { PhoneJetHubAlias.preflight(root) }.isFailure)
        assertEquals("keep",File(modules[0],"dsh-providers-hub/other.txt").readText())
    }
}
