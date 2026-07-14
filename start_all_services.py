#!/usr/bin/env python3
import os
import sys
import time
import subprocess
import signal
import shutil
from absl import app
from absl import flags
from absl import logging

FLAGS = flags.FLAGS
flags.DEFINE_string("workspace_dir", "", "Path to the platform workspace directory. If empty, uses the script directory.")

processes = {}
log_files = []

def check_command_exists(cmd):
    return shutil.which(cmd) is not None

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
    # Check if redis is already listening on 6379
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1)
        s.connect(("127.0.0.1", 6379))
        s.close()
        logging.info("REDIS: Redis server is already running on port 6379.")
    except:
        # Not running, let's start it
        if check_command_exists("redis-server"):
            logging.warning("REDIS: Redis is not running. Launching redis-server...")
            redis_log = open(os.path.join(log_dir, "redis.log"), "w")
            log_files.append(redis_log)
            proc = subprocess.Popen(["redis-server"], stdout=redis_log, stderr=redis_log)
            processes["Redis"] = proc
            time.sleep(1) # Allow redis to initialize
        else:
            logging.error("REDIS: Error: redis-server command not found. Please install and run Redis on 6379 first.")
            sys.exit(1)

    # 3. Start Backend Services via Bazel
    components = {
        "EMS": ["bazel", "run", "//cmd/ems"],
        "RiskNode": ["bazel", "run", "//cmd/risk_node"],
        "MDG": ["bazel", "run", "//cmd/mdg"],
        "BFFGateway": ["bazel", "run", "//cmd/bff", "--", "--port=8080", "--redis-addr=localhost:6379", "--dev-mode"]
    }

    for name, cmd in components.items():
        logging.info("%s: Launching service via Bazel: %s...", name, ' '.join(cmd))
        log_file = open(os.path.join(log_dir, f"{name.lower()}.log"), "w")
        log_files.append(log_file)
        
        # Start process
        proc = subprocess.Popen(cmd, stdout=log_file, stderr=log_file, cwd=workspace_dir)
        processes[name] = proc
        time.sleep(0.5) # Prevent build output collision logs

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
    
    proc = subprocess.Popen(["npm", "start"], stdout=web_log, stderr=web_log, cwd=web_dir)
    processes["WebConsole"] = proc

    logging.info("="*60)
    logging.info("Bulldog Alpha Platform Started Successfully!")
    logging.info("Monitoring Dashboard: http://localhost:3000")
    logging.info("BFF REST / WS API Gateway: http://localhost:8080")
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
