#!/usr/bin/env python3
import datetime
import os
import sys
import subprocess
import signal
import shutil
import platform
import threading
import time
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
flags.DEFINE_string(
    "polygon_url",
    "ws://bff:8080/polygon",
    "The WebSocket URL to connect for Polygon.io market data feed."
)
flags.DEFINE_string(
    "polygon_api_key",
    "",
    "The API Key to authenticate with Polygon.io. Leave empty if using Mock Feed."
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
        compose_cmd = ["docker", "compose", "up", "--build"]

        stop_monitor = threading.Event()

        def monitor_bff_shutdown():
            while not stop_monitor.is_set():
                time.sleep(2)
                try:
                    res = subprocess.run(
                        ["docker", "inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", "bulldog_bff"],
                        capture_output=True,
                        text=True
                    )
                    if res.returncode == 0:
                        parts = res.stdout.strip().split()
                        if len(parts) == 2:
                            status, exit_code = parts
                            if status == "exited" and exit_code == "0":
                                logging.info("SYSTEM: BFF container exited gracefully via developer shutdown trigger. Initiating full clean shutdown...")
                                subprocess.run(["docker", "compose", "down"], capture_output=True)
                                os._exit(_EXIT_SUCCESS)
                except Exception:
                    pass

        monitor_thread = threading.Thread(target=monitor_bff_shutdown, daemon=True)
        monitor_thread.start()
        
        env = os.environ.copy()
        env["POLYGON_URL"] = FLAGS.polygon_url
        env["POLYGON_API_KEY"] = FLAGS.polygon_api_key

        try:
            # This will block until the user exits or containers exit.
            # When Ctrl+C is pressed, the signal handler handle_shutdown will trigger.
            subprocess.run(compose_cmd, check=True, env=env)
        except subprocess.CalledProcessError as e:
            logging.error("SYSTEM: Docker Compose exited with error: %s", e)
            sys.exit(_EXIT_FAILURE)
        finally:
            stop_monitor.set()

def main(argv):
    del argv  # Unused
    orchestrator = DockerOrchestrator()
    orchestrator.run()

if __name__ == "__main__":
    # If the user did not explicitly supply a flagfile or manual polygon parameters,
    # and a local 'local.flags' configuration file exists, load it by default.
    has_explicit_config = any(
        arg.startswith("--flagfile") or 
        arg.startswith("--polygon_url") or 
        arg.startswith("--polygon_api_key") 
        for arg in sys.argv
    )
    if not has_explicit_config:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        workspace_dir = os.environ.get("BUILD_WORKSPACE_DIRECTORY", script_dir)
        local_flags_path = os.path.join(workspace_dir, "local.flags")
        if os.path.exists(local_flags_path):
            sys.argv.append(f"--flagfile={local_flags_path}")
            
    app.run(main)
