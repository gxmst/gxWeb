"""Exercise the deployment script with fake commands in an isolated checkout."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SHELL = shutil.which("sh")
if not SHELL and os.name == "nt" and shutil.which("git"):
    candidate = Path(shutil.which("git")).resolve().parent.parent / "bin" / "sh.exe"
    if candidate.is_file():
        SHELL = str(candidate)


@unittest.skipUnless(SHELL, "A POSIX shell is needed for deployment script tests")
class DeploymentTests(unittest.TestCase):
    def run_deploy(self, build_exit=0):
        with tempfile.TemporaryDirectory() as temporary:
            checkout = Path(temporary) / "checkout"
            (checkout / "tools").mkdir(parents=True)
            (checkout / ".git").mkdir()
            (checkout / ".env").write_text("TEST_ONLY=1\n", encoding="utf-8")
            (checkout / "tools" / "deploy.sh").write_bytes((ROOT / "tools" / "deploy.sh").read_bytes())
            commands = Path(temporary) / "commands"
            commands.mkdir()
            log = Path(temporary) / "commands.log"
            (commands / "git").write_text(
                '#!/bin/sh\ncase "$1" in branch) printf "main\\n";; esac\n', encoding="utf-8"
            )
            (commands / "docker").write_text(
                '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DEPLOY_TEST_LOG"\n'
                'case "$*" in "compose -p gxweb build") exit "$DEPLOY_TEST_BUILD_EXIT";; esac\n',
                encoding="utf-8",
            )
            for command in commands.iterdir():
                command.chmod(0o755)
            env = {
                **os.environ,
                "DEPLOY_TEST_BIN": commands.as_posix(),
                "DEPLOY_TEST_LOG": log.as_posix(),
                "DEPLOY_TEST_BUILD_EXIT": str(build_exit),
            }
            shell_source = 'PATH="$DEPLOY_TEST_BIN:$PATH"\nexport PATH\nexec sh tools/deploy.sh main'
            if os.name == "nt":
                shell_source = 'DEPLOY_TEST_BIN=$(cygpath -u "$DEPLOY_TEST_BIN")\n' + shell_source
            result = subprocess.run(
                [SHELL, "-c", shell_source], cwd=checkout, env=env,
                capture_output=True, text=True, timeout=15,
            )
            self.assertEqual((checkout / ".env").read_text(encoding="utf-8"), "TEST_ONLY=1\n")
            return result, log.read_text(encoding="utf-8").splitlines() if log.exists() else []

    def test_web_is_recreated_and_its_nginx_config_is_checked_after_build(self):
        result, commands = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(commands, [
            "compose -p gxweb config --quiet",
            "compose -p gxweb build",
            "compose -p gxweb up -d spider control",
            "compose -p gxweb up -d --no-deps --force-recreate web",
            "compose -p gxweb exec -T web nginx -t",
            "compose -p gxweb ps",
        ])

    def test_failed_build_stops_before_any_service_update(self):
        result, commands = self.run_deploy(build_exit=17)
        self.assertEqual(result.returncode, 17, result.stderr)
        self.assertFalse(any(" up " in command for command in commands))


if __name__ == "__main__":
    unittest.main()
