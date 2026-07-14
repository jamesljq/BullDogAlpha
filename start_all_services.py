#!/usr/bin/env python3
import datetime
import os
import sys
import time
import subprocess
import signal
import shutil
import socket
from absl import app
from absl import flags
from absl import logging

FLAGS = flags.FLAGS

flags.DEFINE_string(
    "redis_addr",
    "127.0.0.1:6379",
    "The address format '<host>:<port>' where the Redis server is listening or "
    "will be started. Used by the BFF Gateway and other backend services for "
    "circuit breaking and state sharing."
)
flags.DEFINE_string(
    "workspace_dir",
    "",
    "The absolute or relative path to the platform workspace directory (monorepo root). "
    "If not specified, defaults to the directory containing this script. All Bazel "
    "and npm commands will be executed with this directory as the working directory."
)
flags.DEFINE_boolean(
    "dev_mode",
    True,
    "Toggles the developer mode controls on the BFF Gateway. If enabled, the BFF "
    "Gateway exposes the admin /api/shutdown endpoint, which allows the React Web "
    "Console to shut down the entire backend service topology locally."
)
flags.DEFINE_string(
    "bff_addr",
    "127.0.0.1:8080",
    "The address format '<host>:<port>' on which the BFF (Backend-For-Frontend) HTTP "
    "and WebSocket gateway server will listen. Exposed to the Web Console."
)
flags.DEFINE_string(
    "mdg_addr",
    "127.0.0.1:50053",
    "The gRPC address format '<host>:<port>' of the Market Data Generator (MDG) service. "
    "The script probes this address to verify service availability before continuing."
)
flags.DEFINE_string(
    "risk_addr",
    "127.0.0.1:50051",
    "The gRPC address format '<host>:<port>' of the Risk Node service. The script "
    "probes this address to verify service availability before continuing."
)
flags.DEFINE_string(
    "ems_addr",
    "127.0.0.1:50052",
    "The gRPC address format '<host>:<port>' of the Execution Management System (EMS) service. "
    "The script probes this address to verify service availability before continuing."
)
flags.DEFINE_string(
    "engine_addr",
    "127.0.0.1:50054",
    "The gRPC address format '<host>:<port>' of the Alpha Engine mock service. Probed "
    "for verification."
)
flags.DEFINE_string(
    "web_addr",
    "127.0.0.1:3000",
    "The address format '<host>:<port>' where the React-based Web Console frontend "
    "server will listen. This port will be mapped to the Node.js PORT environment variable."
)

def validate_addr(addr):
    if ":" not in addr:
        return False
    parts = addr.rsplit(":", 1)
    if len(parts) != 2:
        return False
    host, port_str = parts
    if not host:
        return False
    try:
        port = int(port_str)
        return 1 <= port <= 65535
    except ValueError:
        return False

# Register validators for all address flags
for flag_name in ["redis_addr", "bff_addr", "mdg_addr", "risk_addr", "ems_addr", "engine_addr", "web_addr"]:
    flags.register_validator(
        flag_name,
        validate_addr,
        message=f"Flag --{flag_name} must be in '<host>:<port>' format with a port between 1 and 65535."
    )

# Private constants for process lifecycle timings
_PROCESS_TERMINATE_TIMEOUT = datetime.timedelta(seconds=3)
_REDIS_STARTUP_TIMEOUT = datetime.timedelta(seconds=10)
_SERVICE_STARTUP_TIMEOUT = datetime.timedelta(seconds=20)
_POLL_INTERVAL = datetime.timedelta(seconds=0.1)
_SOCKET_TIMEOUT = datetime.timedelta(seconds=0.5)

# Exit status codes
_EXIT_SUCCESS = 0
_EXIT_FAILURE = 1

def check_command_exists(cmd):
    return shutil.which(cmd) is not None

def wait_for_service(host, port, name, timeout):
    logging.info("SYSTEM: Waiting for %s to become available on %s:%d...", name, host, port)
    start_time = time.time()
    timeout_seconds = timeout.total_seconds()
    while time.time() - start_time < timeout_seconds:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(_SOCKET_TIMEOUT.total_seconds())
            s.connect((host, port))
            s.close()
            logging.info("SYSTEM: %s is now available.", name)
            return True
        except Exception:
            time.sleep(_POLL_INTERVAL.total_seconds())
    logging.error("SYSTEM: Timeout waiting for %s on %s:%d.", name, host, port)
    return False

class PlatformManager:
    """Manages the lifecycle of all microservices in the monorepo."""

    def __init__(self):
        self.processes = {}
        self.log_files = []
        
        # Register signal handlers to instance method
        signal.signal(signal.SIGINT, self.clean_shutdown)
        signal.signal(signal.SIGTERM, self.clean_shutdown)

    def clean_shutdown(self, signum, frame):
        logging.warning("SYSTEM: Gracefully shutting down all components...")
        
        for name, proc in list(self.processes.items()):
            logging.warning("SYSTEM: Stopping %s (PID: %d)...", name, proc.pid)
            try:
                # Send SIGTERM first
                proc.terminate()
                try:
                    proc.wait(timeout=_PROCESS_TERMINATE_TIMEOUT.total_seconds())
                except subprocess.TimeoutExpired:
                    # Force kill if hung
                    proc.kill()
                    proc.wait()
                logging.info("SYSTEM: %s stopped successfully.", name)
            except Exception as e:
                logging.error("SYSTEM: Failed to stop %s: %s", name, e)
                
        for f in self.log_files:
            try:
                f.close()
            except:
                pass
                
        logging.info("SYSTEM: All components shut down. Goodbye!")
        sys.exit(_EXIT_SUCCESS)

    def run(self):
        workspace_dir = FLAGS.workspace_dir if FLAGS.workspace_dir else os.path.dirname(os.path.abspath(__file__))
        os.chdir(workspace_dir)

        # 1. Create logs directory
        log_dir = os.path.join(workspace_dir, "logs")
        os.makedirs(log_dir, exist_ok=True)
        logging.info("SYSTEM: Redirecting outputs to log files in: %s", log_dir)

        # 2. Check and start Redis
        logging.info("REDIS: Verifying Redis server availability...")
        
        redis_host, redis_port_str = FLAGS.redis_addr.rsplit(":", 1)
        redis_port = int(redis_port_str)

        # Check if redis is already listening
        redis_running = False
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(_SOCKET_TIMEOUT.total_seconds())
            s.connect((redis_host, redis_port))
            s.close()
            redis_running = True
            logging.info("REDIS: Redis server is already running on %s:%d.", redis_host, redis_port)
        except:
            pass

        if not redis_running:
            if check_command_exists("redis-server"):
                logging.warning("REDIS: Redis is not running. Launching redis-server on %s:%d...", redis_host, redis_port)
                redis_log = open(os.path.join(log_dir, "redis.log"), "w")
                self.log_files.append(redis_log)
                proc = subprocess.Popen(["redis-server", "--port", str(redis_port)], stdout=redis_log, stderr=redis_log)
                self.processes["Redis"] = proc
                
                if not wait_for_service(redis_host, redis_port, "Redis", timeout=_REDIS_STARTUP_TIMEOUT):
                    logging.error("REDIS: Failed to start Redis server.")
                    sys.exit(_EXIT_FAILURE)
            else:
                logging.error("REDIS: Error: redis-server command not found. Please install and run Redis on %s:%d first.", redis_host, redis_port)
                sys.exit(_EXIT_FAILURE)

        # 3. Start Backend Services via Bazel
        bff_host, bff_port_str = FLAGS.bff_addr.rsplit(":", 1)
        bff_port = int(bff_port_str)

        components = {
            "EMS": ["bazel", "run", "//cmd/ems"],
            "RiskNode": ["bazel", "run", "//cmd/risk_node"],
            "MDG": ["bazel", "run", "//cmd/mdg"],
            "BFFGateway": ["bazel", "run", "//cmd/bff", "--", f"--port={bff_port}", f"--redis-addr={FLAGS.redis_addr}"]
        }

        if FLAGS.dev_mode:
            components["BFFGateway"].append("--dev-mode")

        port_mapping = {
            "EMS": int(FLAGS.ems_addr.rsplit(":", 1)[1]),
            "RiskNode": int(FLAGS.risk_addr.rsplit(":", 1)[1]),
            "MDG": int(FLAGS.mdg_addr.rsplit(":", 1)[1]),
            "BFFGateway": bff_port
        }

        for name, cmd in components.items():
            logging.info("%s: Launching service via Bazel: %s...", name, ' '.join(cmd))
            log_file = open(os.path.join(log_dir, f"{name.lower()}.log"), "w")
            self.log_files.append(log_file)
            
            # Start process
            proc = subprocess.Popen(cmd, stdout=log_file, stderr=log_file, cwd=workspace_dir)
            self.processes[name] = proc
            
            # Wait for the service to start up deterministically by checking its port
            if not wait_for_service("127.0.0.1", port_mapping[name], name, timeout=_SERVICE_STARTUP_TIMEOUT):
                logging.error("SYSTEM: Failed to verify that %s started successfully.", name)
                self.clean_shutdown(None, None)

        # 4. Handle web UI Setup and start
        web_dir = os.path.join(workspace_dir, "web")
        node_modules = os.path.join(web_dir, "node_modules")
        
        if not os.path.exists(node_modules):
            if check_command_exists("npm"):
                logging.warning("WEB: Initializing frontend. Running 'npm install' inside web/ (this may take a moment)...")
                try:
                    subprocess.run(["npm", "install"], cwd=web_dir, check=True)
                    logging.info("WEB: Dependencies installed successfully.")
                except subprocess.CalledProcessError as e:
                    logging.error("WEB: Failed to run npm install: %s", e)
                    self.clean_shutdown(None, None)
            else:
                logging.error("WEB: Error: 'npm' is not installed. You will not be able to run the React App server.")
                self.clean_shutdown(None, None)

        # Launch React App server
        logging.info("WEB: Starting React Development Server (npm start)...")
        web_log = open(os.path.join(log_dir, "web.log"), "w")
        self.log_files.append(web_log)
        
        web_host, web_port_str = FLAGS.web_addr.rsplit(":", 1)
        web_port = int(web_port_str)

        # Configure PORT env variable for npm start
        env = os.environ.copy()
        env["PORT"] = str(web_port)
        
        proc = subprocess.Popen(["npm", "start"], stdout=web_log, stderr=web_log, cwd=web_dir, env=env)
        self.processes["WebConsole"] = proc

        # Wait for React to start up deterministically
        if not wait_for_service("127.0.0.1", web_port, "WebConsole", timeout=_SERVICE_STARTUP_TIMEOUT):
            logging.error("SYSTEM: Failed to verify that WebConsole started successfully.")
            self.clean_shutdown(None, None)

        logging.info("Bulldog Alpha Platform Started Successfully!")
        logging.info("Monitoring Dashboard: http://localhost:%d", web_port)
        logging.info("BFF REST / WS API Gateway: http://localhost:%d", bff_port)
        logging.info("Log directory: %s", log_dir)
        logging.info("To stop all services cleanly, press Ctrl+C")

        # Monitor subprocesses using os.wait() (kernel-level event blocking)
        while self.processes:
            try:
                pid, status = os.wait()
                # Find which process exited
                exited_name = None
                for name, proc in list(self.processes.items()):
                    if proc.pid == pid:
                        exited_name = name
                        break
                
                if exited_name:
                    exit_code = (status >> 8) if (status & 0xff) == 0 else -(status & 0x7f)
                    if exited_name == "BFFGateway":
                        logging.warning("SYSTEM: BFFGateway (PID: %d) has exited with code %d. Shutting down all other services cleanly...", pid, exit_code)
                        self.clean_shutdown(None, None)
                    logging.warning("SYSTEM: Warning: %s (PID: %d) exited unexpectedly with code %d.", exited_name, pid, exit_code)
                    logging.warning("SYSTEM: Check %s/%s.log for error details.", log_dir, exited_name.lower())
                    del self.processes[exited_name]
            except ChildProcessError:
                # No child processes left to wait for
                break
            except InterruptedError:
                # Interrupted by signal handler (Ctrl+C)
                continue

def main(argv):
    del argv  # Unused
    manager = PlatformManager()
    manager.run()

if __name__ == "__main__":
    app.run(main)
