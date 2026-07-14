#!/usr/bin/env python3
import datetime
import os
import sys
import subprocess
import signal
import shutil
import platform
from absl import app
from absl import flags
from absl import logging

FLAGS = flags.FLAGS

flags.DEFINE_string(
    "workspace_dir",
    "",
    "The absolute or relative path to the platform workspace directory. "
    "If not specified, automatically detects from BUILD_WORKSPACE_DIRECTORY "
    "or defaults to the directory containing this script."
)
flags.DEFINE_boolean(
    "dev_mode",
    True,
    "Toggles the developer mode on the BFF Gateway inside Docker Compose."
)

_EXIT_SUCCESS = 0
_EXIT_FAILURE = 1

class DockerOrchestrator:
    """Manages cross-compilation and Docker Compose execution for the Bulldog Alpha services."""

    def __init__(self):
        # Register signal handlers for clean teardown
        signal.signal(signal.SIGINT, self.handle_shutdown)
        signal.signal(signal.SIGTERM, self.handle_shutdown)

    def handle_shutdown(self, signum, frame):
        logging.warning("SYSTEM: Captured shutdown signal. Stopping Docker Compose services...")
        try:
            # Run docker compose down to stop and remove all containers
            subprocess.run(["docker", "compose", "down"], check=True)
            logging.info("SYSTEM: Docker Compose services stopped and cleaned up.")
        except subprocess.CalledProcessError as e:
            logging.error("SYSTEM: Failed to clean up Docker Compose services: %s", e)
        sys.exit(_EXIT_SUCCESS)

    def check_tool_dependencies(self):
        for tool in ["bazel", "docker"]:
            if not shutil.which(tool):
                logging.error("SYSTEM: Required tool '%s' is not installed or not in PATH.", tool)
                sys.exit(_EXIT_FAILURE)

    def run(self):
        self.check_tool_dependencies()

        workspace_dir = FLAGS.workspace_dir
        if not workspace_dir:
            workspace_dir = os.environ.get("BUILD_WORKSPACE_DIRECTORY")
        if not workspace_dir:
            workspace_dir = os.path.dirname(os.path.abspath(__file__))
        os.chdir(workspace_dir)

        # 1. Detect architecture for cross-compilation
        machine = platform.machine().lower()
        if "arm64" in machine or "aarch64" in machine:
            target_platform = "linux_arm64"
        else:
            target_platform = "linux_amd64"
        logging.info("SYSTEM: Detected architecture: %s. Compiling for platform target: %s.", machine, target_platform)

        # 2. Run Bazel build for target platform
        build_cmd = [
            "bazel", "build",
            f"--platforms=@rules_go//go/toolchain:{target_platform}",
            "//cmd/ems", "//cmd/risk_node", "//cmd/mdg", "//cmd/bff"
        ]
        logging.info("SYSTEM: Executing Bazel cross-compilation: %s", " ".join(build_cmd))
        try:
            subprocess.run(build_cmd, check=True)
            logging.info("SYSTEM: Bazel build completed successfully.")
        except subprocess.CalledProcessError as e:
            logging.error("SYSTEM: Bazel cross-compilation failed: %s", e)
            sys.exit(_EXIT_FAILURE)

        # 3. Re-create local bin directory and stage binaries
        bin_dir = os.path.join(workspace_dir, "bin")
        os.makedirs(bin_dir, exist_ok=True)

        services = ["ems", "risk_node", "mdg", "bff"]
        logging.info("SYSTEM: Staging Linux binaries into bin/ directory...")
        for svc in services:
            src_path = os.path.join(workspace_dir, "bazel-bin", "cmd", svc, f"{svc}_", svc)
            dst_path = os.path.join(bin_dir, svc)
            try:
                # Remove existing read-only file if present to avoid permission errors
                if os.path.exists(dst_path):
                    os.remove(dst_path)
                shutil.copy2(src_path, dst_path)
            except Exception as e:
                logging.error("SYSTEM: Failed to stage binary for %s: %s", svc, e)
                sys.exit(_EXIT_FAILURE)

        # 4. Launch Docker Compose up
        logging.info("SYSTEM: Launching Docker Compose cluster...")
        compose_cmd = ["docker", "compose", "up", "--build", "--abort-on-container-exit"]
        
        try:
            # This will block until the user exits or containers exit.
            # When Ctrl+C is pressed, the signal handler handle_shutdown will trigger.
            subprocess.run(compose_cmd, check=True)
        except subprocess.CalledProcessError as e:
            logging.error("SYSTEM: Docker Compose exited with error: %s", e)
            sys.exit(_EXIT_FAILURE)

def main(argv):
    del argv  # Unused
    orchestrator = DockerOrchestrator()
    orchestrator.run()

if __name__ == "__main__":
    app.run(main)
