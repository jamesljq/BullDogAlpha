#!/usr/bin/env python3
import os
import sys
import time
import subprocess
import signal
import shutil

# Color definitions
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
BLUE = "\033[94m"
RESET = "\033[0m"

processes = {}
log_files = []

def print_log(service, message, color=GREEN):
    print(f"{color}[{service}]{RESET} {message}")

def check_command_exists(cmd):
    return shutil.which(cmd) is not None

def clean_shutdown(signum, frame):
    print("\n")
    print_log("SYSTEM", "Gracefully shutting down all components...", YELLOW)
    
    for name, proc in list(processes.items()):
        print_log("SYSTEM", f"Stopping {name} (PID: {proc.pid})...", YELLOW)
        try:
            # Send SIGTERM first
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                # Force kill if hung
                proc.kill()
                proc.wait()
            print_log("SYSTEM", f"{name} stopped successfully.", GREEN)
        except Exception as e:
            print_log("SYSTEM", f"Failed to stop {name}: {e}", RED)
            
    for f in log_files:
        try:
            f.close()
        except:
            pass
            
    print_log("SYSTEM", "All components shut down. Goodbye!", GREEN)
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
    print_log("SYSTEM", f"Redirecting outputs to log files in: {log_dir}", BLUE)

    # 2. Check and start Redis
    print_log("REDIS", "Verifying Redis server availability...", BLUE)
    # Check if redis is already listening on 6379
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1)
        s.connect(("127.0.0.1", 6379))
        s.close()
        print_log("REDIS", "Redis server is already running on port 6379.", GREEN)
    except:
        # Not running, let's start it
        if check_command_exists("redis-server"):
            print_log("REDIS", "Redis is not running. Launching redis-server...", YELLOW)
            redis_log = open(os.path.join(log_dir, "redis.log"), "w")
            log_files.append(redis_log)
            proc = subprocess.Popen(["redis-server"], stdout=redis_log, stderr=redis_log)
            processes["Redis"] = proc
            time.sleep(1) # Allow redis to initialize
        else:
            print_log("REDIS", "Error: redis-server command not found. Please install and run Redis on 6379 first.", RED)
            sys.exit(1)

    # 3. Start Backend Services via Bazel
    components = {
        "EMS": ["bazel", "run", "//cmd/ems"],
        "RiskNode": ["bazel", "run", "//cmd/risk_node"],
        "MDG": ["bazel", "run", "//cmd/mdg"],
        "BFFGateway": ["bazel", "run", "//cmd/bff", "--", "--port=8080", "--redis-addr=localhost:6379"]
    }

    for name, cmd in components.items():
        print_log(name, f"Launching service via Bazel: {' '.join(cmd)}...", BLUE)
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
            print_log("WEB", "Initializing frontend. Running 'npm install' inside web/ (this may take a moment)...", YELLOW)
            try:
                subprocess.run(["npm", "install"], cwd=web_dir, check=True)
                print_log("WEB", "Dependencies installed successfully.", GREEN)
            except subprocess.CalledProcessError as e:
                print_log("WEB", f"Failed to run npm install: {e}", RED)
                clean_shutdown(None, None)
        else:
            print_log("WEB", "Error: 'npm' is not installed. You will not be able to run the React App server.", RED)
            clean_shutdown(None, None)

    # Launch React App server
    print_log("WEB", "Starting React Development Server (npm start)...", BLUE)
    web_log = open(os.path.join(log_dir, "web.log"), "w")
    log_files.append(web_log)
    
    proc = subprocess.Popen(["npm", "start"], stdout=web_log, stderr=web_log, cwd=web_dir)
    processes["WebConsole"] = proc

    print("\n" + "="*60)
    print(f"{GREEN}Bulldog Alpha Platform Started Successfully!{RESET}")
    print(f"Monitoring Dashboard: {GREEN}http://localhost:3000{RESET}")
    print(f"BFF REST / WS API Gateway: {GREEN}http://localhost:8080{RESET}")
    print(f"Log directory: {BLUE}{log_dir}{RESET}")
    print(f"To stop all services cleanly, press {RED}Ctrl+C{RESET}")
    print("="*60 + "\n")

    # Monitor subprocesses
    while True:
        for name, proc in list(processes.items()):
            ret = proc.poll()
            if ret is not None:
                print_log("SYSTEM", f"Warning: {name} (PID: {proc.pid}) exited unexpectedly with code {ret}.", RED)
                # Keep checking log outputs
                print_log("SYSTEM", f"Check {log_dir}/{name.lower()}.log for error details.", RED)
                del processes[name]
        time.sleep(2)

if __name__ == "__main__":
    main()
