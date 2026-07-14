#!/usr/bin/env python3
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
flags.DEFINE_string("redis_host", "127.0.0.1", "Redis server host.")
flags.DEFINE_integer("redis_port", 6379, "Redis server port.")
flags.DEFINE_string("workspace_dir", "", "Path to the platform workspace directory. If empty, uses the script directory.")
flags.DEFINE_boolean("dev_mode", True, "Enable developer mode controls on BFF Gateway.")
flags.DEFINE_integer("bff_port", 8080, "BFF Gateway port.")
flags.DEFINE_string("mdg_addr", "localhost:50053", "MDG gRPC address.")
flags.DEFINE_string("risk_addr", "localhost:50051", "Risk Node gRPC address.")
flags.DEFINE_string("ems_addr", "localhost:50052", "EMS gRPC address.")
flags.DEFINE_string("engine_addr", "localhost:50054", "Alpha Engine mock gRPC address.")
flags.DEFINE_integer("web_port", 3000, "Web Console port.")

processes = {}
log_files = []

def check_command_exists(cmd):
    return shutil.which(cmd) is not None

def wait_for_service(host, port, name, timeout=15):
    logging.info("SYSTEM: Waiting for %s to become available on %s:%d...", name, host, port)
    start_time = time.time()
    while time.time() - start_time < timeout:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(0.5)
            s.connect((host, port))
            s.close()
            logging.info("SYSTEM: %s is now available.", name)
            return True
        except Exception:
            time.sleep(0.1)
    logging.error("SYSTEM: Timeout waiting for %s on %s:%d.", name, host, port)
    return False

def clean_shutdown(signum, frame):
    logging.warning("SYSTEM: Gracefully shutting down all components...")
    
    for name, proc in list(processes.items()):
        logging.warning("SYSTEM: Stopping %s (PID: %d)...", name, proc.pid)
        try:
            # Send SIGTERM first
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                # Force kill if hung
                proc.kill()
                proc.wait()
            logging.info("SYSTEM: %s stopped successfully.", name)
        except Exception as e:
            logging.error("SYSTEM: Failed to stop %s: %s", name, e)
            
    for f in log_files:
        try:
            f.close()
        except:
            pass
            
    logging.info("SYSTEM: All components shut down. Goodbye!")
    sys.exit(0)

# Register Ctrl+C handler
signal.signal(signal.SIGINT, clean_shutdown)
signal.signal(signal.SIGTERM, clean_shutdown)

def main(argv):
    del argv  # Unused
    workspace_dir = FLAGS.workspace_dir if FLAGS.workspace_dir else os.path.dirname(os.path.abspath(__file__))
    os.chdir(workspace_dir)

    # 1. Create logs directory
    log_dir = os.path.join(workspace_dir, "logs")
    os.makedirs(log_dir, exist_ok=True)
    logging.info("SYSTEM: Redirecting outputs to log files in: %s", log_dir)

    # 2. Check and start Redis
    logging.info("REDIS: Verifying Redis server availability...")
    
    # Check if redis is already listening
    redis_running = False
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(0.5)
        s.connect((FLAGS.redis_host, FLAGS.redis_port))
        s.close()
        redis_running = True
        logging.info("REDIS: Redis server is already running on port %d.", FLAGS.redis_port)
    except:
        pass

    if not redis_running:
        if check_command_exists("redis-server"):
            logging.warning("REDIS: Redis is not running. Launching redis-server on port %d...", FLAGS.redis_port)
            redis_log = open(os.path.join(log_dir, "redis.log"), "w")
            log_files.append(redis_log)
            proc = subprocess.Popen(["redis-server", "--port", str(FLAGS.redis_port)], stdout=redis_log, stderr=redis_log)
            processes["Redis"] = proc
            
            # Wait for Redis to start up deterministically
            if not wait_for_service(FLAGS.redis_host, FLAGS.redis_port, "Redis", timeout=10):
                logging.error("REDIS: Failed to start Redis server.")
                sys.exit(1)
        else:
            logging.error("REDIS: Error: redis-server command not found. Please install and run Redis on %d first.", FLAGS.redis_port)
            sys.exit(1)

    # 3. Start Backend Services via Bazel
    components = {
        "EMS": ["bazel", "run", "//cmd/ems"],
        "RiskNode": ["bazel", "run", "//cmd/risk_node"],
        "MDG": ["bazel", "run", "//cmd/mdg"],
        "BFFGateway": ["bazel", "run", "//cmd/bff", "--", f"--port={FLAGS.bff_port}", f"--redis-addr={FLAGS.redis_host}:{FLAGS.redis_port}"]
    }

    if FLAGS.dev_mode:
        components["BFFGateway"].append("--dev-mode")

    port_mapping = {
        "EMS": 50052,
        "RiskNode": 50051,
        "MDG": 50053,
        "BFFGateway": FLAGS.bff_port
    }

    for name, cmd in components.items():
        logging.info("%s: Launching service via Bazel: %s...", name, ' '.join(cmd))
        log_file = open(os.path.join(log_dir, f"{name.lower()}.log"), "w")
        log_files.append(log_file)
        
        # Start process
        proc = subprocess.Popen(cmd, stdout=log_file, stderr=log_file, cwd=workspace_dir)
        processes[name] = proc
        
        # Wait for the service to start up deterministically by checking its port
        if not wait_for_service("127.0.0.1", port_mapping[name], name, timeout=20):
            logging.error("SYSTEM: Failed to verify that %s started successfully.", name)
            clean_shutdown(None, None)

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
                clean_shutdown(None, None)
        else:
            logging.error("WEB: Error: 'npm' is not installed. You will not be able to run the React App server.")
            clean_shutdown(None, None)

    # Launch React App server
    logging.info("WEB: Starting React Development Server (npm start)...")
    web_log = open(os.path.join(log_dir, "web.log"), "w")
    log_files.append(web_log)
    
    # Configure PORT env variable for npm start
    env = os.environ.copy()
    env["PORT"] = str(FLAGS.web_port)
    
    proc = subprocess.Popen(["npm", "start"], stdout=web_log, stderr=web_log, cwd=web_dir, env=env)
    processes["WebConsole"] = proc

    # Wait for React to start up deterministically
    if not wait_for_service("127.0.0.1", FLAGS.web_port, "WebConsole", timeout=20):
        logging.error("SYSTEM: Failed to verify that WebConsole started successfully.")
        clean_shutdown(None, None)

    logging.info("="*60)
    logging.info("Bulldog Alpha Platform Started Successfully!")
    logging.info("Monitoring Dashboard: http://localhost:%d", FLAGS.web_port)
    logging.info("BFF REST / WS API Gateway: http://localhost:%d", FLAGS.bff_port)
    logging.info("Log directory: %s", log_dir)
    logging.info("To stop all services cleanly, press Ctrl+C")
    logging.info("="*60)

    # Monitor subprocesses
    while True:
        for name, proc in list(processes.items()):
            ret = proc.poll()
            if ret is not None:
                if name == "BFFGateway":
                    logging.warning("SYSTEM: BFFGateway has exited. Shutting down all other services cleanly...")
                    clean_shutdown(None, None)
                logging.warning("SYSTEM: Warning: %s (PID: %d) exited unexpectedly with code %d.", name, proc.pid, ret)
                # Keep checking log outputs
                logging.warning("SYSTEM: Check %s/%s.log for error details.", log_dir, name.lower())
                del processes[name]
        time.sleep(2)

if __name__ == "__main__":
    app.run(main)
