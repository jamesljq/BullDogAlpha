#!/usr/bin/env python3
import os
import sys
import time
import subprocess
import signal
import shutil

try:
    from absl import logging
except ImportError:
    import logging
    # Setup basic logging to stderr in Abseil style
    logging.basicConfig(
        level=logging.INFO,
        format='%(levelname).1s%(asctime)s %(filename)s:%(lineno)d] %(message)s',
        datefmt='%m%d %H:%M:%S'
    )

# Color definitions
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
BLUE = "\033[94m"
RESET = "\033[0m"

processes = {}
log_files = []

def print_log(service, message, level="info", color=GREEN):
    msg = f"{color}[{service}]{RESET} {message}"
    if level == "info":
        logging.info(msg)
    elif level == "warning":
        logging.warning(msg)
    elif level == "error":
        logging.error(msg)

def check_command_exists(cmd):
    return shutil.which(cmd) is not None

def clean_shutdown(signum, frame):
    print_log("SYSTEM", "Gracefully shutting down all components...", "warning", YELLOW)
    
    for name, proc in list(processes.items()):
        print_log("SYSTEM", f"Stopping {name} (PID: {proc.pid})...", "warning", YELLOW)
        try:
            # Send SIGTERM first
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                # Force kill if hung
                proc.kill()
                proc.wait()
            print_log("SYSTEM", f"{name} stopped successfully.", "info", GREEN)
        except Exception as e:
            print_log("SYSTEM", f"Failed to stop {name}: {e}", "error", RED)
            
    for f in log_files:
        try:
            f.close()
        except:
            pass
            
    print_log("SYSTEM", "All components shut down. Goodbye!", "info", GREEN)
    sys.exit(0)

# Register Ctrl+C handler
signal.signal(signal.SIGINT, clean_shutdown)
signal.signal(signal.SIGTERM, clean_shutdown)

def main():
    workspace_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(workspace_dir)

    # 1. Create logs directory
    log_dir = os.path.join(workspace_dir, "logs")
    os.makedirs(log_dir, exist_ok=True)
    print_log("SYSTEM", f"Redirecting outputs to log files in: {log_dir}", "info", BLUE)

    # 2. Check and start Redis
    print_log("REDIS", "Verifying Redis server availability...", "info", BLUE)
    # Check if redis is already listening on 6379
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1)
        s.connect(("127.0.0.1", 6379))
        s.close()
        print_log("REDIS", "Redis server is already running on port 6379.", "info", GREEN)
    except:
        # Not running, let's start it
        if check_command_exists("redis-server"):
            print_log("REDIS", "Redis is not running. Launching redis-server...", "warning", YELLOW)
            redis_log = open(os.path.join(log_dir, "redis.log"), "w")
            log_files.append(redis_log)
            proc = subprocess.Popen(["redis-server"], stdout=redis_log, stderr=redis_log)
            processes["Redis"] = proc
            time.sleep(1) # Allow redis to initialize
        else:
            print_log("REDIS", "Error: redis-server command not found. Please install and run Redis on 6379 first.", "error", RED)
            sys.exit(1)

    # 3. Start Backend Services via Bazel
    components = {
        "EMS": ["bazel", "run", "//cmd/ems"],
        "RiskNode": ["bazel", "run", "//cmd/risk_node"],
        "MDG": ["bazel", "run", "//cmd/mdg"],
        "BFFGateway": ["bazel", "run", "--run_under=cd . &&", "//cmd/bff", "--", "--port=8080", "--redis-addr=localhost:6379"]
    }
    
    # Clean up commands list for bff gateway target execution mapping
    components["BFFGateway"] = ["bazel", "run", "//cmd/bff", "--", "--port=8080", "--redis-addr=localhost:6379", "--dev-mode"]

    for name, cmd in components.items():
        print_log(name, f"Launching service via Bazel: {' '.join(cmd)}...", "info", BLUE)
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
            print_log("WEB", "Initializing frontend. Running 'npm install' inside web/ (this may take a moment)...", "warning", YELLOW)
            try:
                subprocess.run(["npm", "install"], cwd=web_dir, check=True)
                print_log("WEB", "Dependencies installed successfully.", "info", GREEN)
            except subprocess.CalledProcessError as e:
                print_log("WEB", f"Failed to run npm install: {e}", "error", RED)
                clean_shutdown(None, None)
        else:
            print_log("WEB", "Error: 'npm' is not installed. You will not be able to run the React App server.", "error", RED)
            clean_shutdown(None, None)

    # Launch React App server
    print_log("WEB", "Starting React Development Server (npm start)...", "info", BLUE)
    web_log = open(os.path.join(log_dir, "web.log"), "w")
    log_files.append(web_log)
    
    proc = subprocess.Popen(["npm", "start"], stdout=web_log, stderr=web_log, cwd=web_dir)
    processes["WebConsole"] = proc

    logging.info("="*60)
    logging.info("Bulldog Alpha Platform Started Successfully!")
    logging.info("Monitoring Dashboard: http://localhost:3000")
    logging.info("BFF REST / WS API Gateway: http://localhost:8080")
    logging.info(f"Log directory: {log_dir}")
    logging.info("To stop all services cleanly, press Ctrl+C")
    logging.info("="*60)

    # Monitor subprocesses
    while True:
        for name, proc in list(processes.items()):
            ret = proc.poll()
            if ret is not None:
                if name == "BFFGateway":
                    print_log("SYSTEM", "BFFGateway has exited. Shutting down all other services cleanly...", "warning", YELLOW)
                    clean_shutdown(None, None)
                print_log("SYSTEM", f"Warning: {name} (PID: {proc.pid}) exited unexpectedly with code {ret}.", "warning", RED)
                # Keep checking log outputs
                print_log("SYSTEM", f"Check {log_dir}/{name.lower()}.log for error details.", "warning", RED)
                del processes[name]
        time.sleep(2)

if __name__ == "__main__":
    main()
