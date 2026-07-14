#!/usr/bin/env python3
import os
import sys
import datetime
import subprocess
import unittest
from unittest.mock import patch, MagicMock, mock_open

# Add current workspace directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import start_all_services

class TestStartAllServices(unittest.TestCase):
    def setUp(self):
        from absl import flags
        try:
            flags.FLAGS(['start_all_services.py'])
        except Exception:
            pass

    @patch('shutil.which')
    def test_check_command_exists(self, mock_which):
        mock_which.return_value = '/usr/local/bin/redis-server'
        self.assertTrue(start_all_services.check_command_exists('redis-server'))
        
        mock_which.return_value = None
        self.assertFalse(start_all_services.check_command_exists('redis-server'))

    @patch('subprocess.Popen')
    @patch('builtins.open', new_callable=mock_open)
    @patch('os.makedirs')
    @patch('socket.socket')
    @patch('shutil.which')
    def test_main_starts_processes(self, mock_which, mock_socket, mock_makedirs, mock_file, mock_popen):
        # Mock commands existence
        mock_which.return_value = '/usr/bin/mock'
        
        # Mock socket.connect to fail, simulating Redis not running yet
        mock_sock_inst = MagicMock()
        mock_sock_inst.connect.side_effect = Exception("not running")
        mock_socket.return_value = mock_sock_inst
        
        # Mock Popen processes
        mock_proc = MagicMock()
        mock_proc.pid = 9999
        mock_proc.poll.return_value = None
        mock_popen.return_value = mock_proc

        # Mock node_modules directory existence
        sleep_count = 0
        def mock_sleep(seconds):
            nonlocal sleep_count
            sleep_count += 1
            if sleep_count > 5:
                raise SystemExit()

        with patch('os.path.exists', return_value=True):
            # Run main, trigger SystemExit after launching all processes
            with patch('start_all_services.wait_for_service', return_value=True):
                with patch('os.wait', side_effect=SystemExit()):
                    with self.assertRaises(SystemExit):
                        start_all_services.main(['start_all_services.py'])
        
        # Assert processes started
        self.assertTrue(mock_popen.called)
        calls = [c[0][0] for c in mock_popen.call_args_list]
        
        self.assertIn(['redis-server', '--port', '6379'], calls)
        self.assertTrue(any('//cmd/ems' in cmd for cmd in calls))
        self.assertTrue(any('//cmd/risk_node' in cmd for cmd in calls))
        self.assertTrue(any('//cmd/mdg' in cmd for cmd in calls))
        self.assertTrue(any('//cmd/bff' in cmd for cmd in calls))
        self.assertIn(['npm', 'start'], calls)

    @patch('sys.exit')
    def test_clean_shutdown(self, mock_exit):
        mock_proc = MagicMock()
        mock_file = MagicMock()
        
        manager = start_all_services.PlatformManager()
        manager.processes = {"MockService": mock_proc}
        manager.log_files = [mock_file]
        
        manager.clean_shutdown(None, None)
        
        mock_proc.terminate.assert_called_once()
        mock_file.close.assert_called_once()
        mock_exit.assert_called_once_with(start_all_services._EXIT_SUCCESS)

    @patch('start_all_services.PlatformManager.clean_shutdown')
    @patch('subprocess.Popen')
    @patch('builtins.open', new_callable=mock_open)
    @patch('os.makedirs')
    @patch('socket.socket')
    @patch('shutil.which')
    def test_bff_exit_triggers_clean_shutdown(self, mock_which, mock_socket, mock_makedirs, mock_file, mock_popen, mock_clean_shutdown):
        mock_which.return_value = '/usr/bin/mock'
        
        # Simulating Redis already running
        mock_sock_inst = MagicMock()
        mock_socket.return_value = mock_sock_inst
        
        # Mock Popen to return a process whose poll returns 0 only when it is BFFGateway
        def mock_popen_fn(cmd, *args, **kwargs):
            proc = MagicMock()
            proc.pid = 9999
            if any('//cmd/bff' in part for part in cmd):
                proc.poll.return_value = 0
            else:
                proc.poll.return_value = None
            return proc
        mock_popen.side_effect = mock_popen_fn
        
        # Make clean_shutdown raise SystemExit to exit main's infinite loop
        mock_clean_shutdown.side_effect = SystemExit()
        
        with patch('os.path.exists', return_value=True):
            with patch('start_all_services.wait_for_service', return_value=True):
                with patch('os.wait', return_value=(9999, 0)):
                    with self.assertRaises(SystemExit):
                        start_all_services.main(['start_all_services.py'])
                
        mock_clean_shutdown.assert_called_once()

    @patch('socket.socket')
    def test_wait_for_service_success(self, mock_socket):
        mock_sock_inst = MagicMock()
        mock_socket.return_value = mock_sock_inst
        mock_sock_inst.connect.return_value = None
        
        self.assertTrue(start_all_services.wait_for_service("127.0.0.1", 8080, "TestService", timeout=datetime.timedelta(seconds=1)))
        mock_sock_inst.connect.assert_called_once_with(("127.0.0.1", 8080))

    @patch('time.sleep')
    @patch('socket.socket')
    def test_wait_for_service_timeout(self, mock_socket, mock_sleep):
        mock_sock_inst = MagicMock()
        mock_socket.return_value = mock_sock_inst
        mock_sock_inst.connect.side_effect = Exception("conn failed")
        
        self.assertFalse(start_all_services.wait_for_service("127.0.0.1", 8080, "TestService", timeout=datetime.timedelta(seconds=0.2)))
        self.assertTrue(mock_sleep.called)

    def test_validate_addr(self):
        self.assertTrue(start_all_services.validate_addr("127.0.0.1:8080"))
        self.assertTrue(start_all_services.validate_addr("[::1]:8080"))
        self.assertTrue(start_all_services.validate_addr("localhost:80"))
        
        self.assertFalse(start_all_services.validate_addr("127.0.0.1"))
        self.assertFalse(start_all_services.validate_addr("127.0.0.1:0"))
        self.assertFalse(start_all_services.validate_addr("127.0.0.1:65536"))
        self.assertFalse(start_all_services.validate_addr("127.0.0.1:abc"))
        self.assertFalse(start_all_services.validate_addr(":8080"))

    @patch('sys.exit')
    def test_clean_shutdown_with_timeout_and_errors(self, mock_exit):
        mock_proc1 = MagicMock()
        mock_proc1.terminate.side_effect = Exception("failed to terminate")
        
        mock_proc2 = MagicMock()
        mock_proc2.wait.side_effect = subprocess.TimeoutExpired(cmd="kill", timeout=3)
        
        mock_file = MagicMock()
        mock_file.close.side_effect = Exception("failed to close")
        
        manager = start_all_services.PlatformManager()
        manager.processes = {
            "FailTerminate": mock_proc1,
            "TimeoutProc": mock_proc2,
        }
        manager.log_files = [mock_file]
        
        manager.clean_shutdown(None, None)
        
        mock_proc2.kill.assert_called_once()
        mock_file.close.assert_called_once()
        mock_exit.assert_called_once_with(start_all_services._EXIT_SUCCESS)



    @patch('sys.exit')
    @patch('subprocess.Popen')
    @patch('builtins.open', new_callable=mock_open)
    @patch('os.makedirs')
    @patch('socket.socket')
    @patch('shutil.which')
    def test_redis_startup_failures(self, mock_which, mock_socket, mock_makedirs, mock_file, mock_popen, mock_exit):
        mock_which.return_value = None
        mock_sock_inst = MagicMock()
        mock_sock_inst.connect.side_effect = Exception("redis not running")
        mock_socket.return_value = mock_sock_inst
        
        mock_exit.side_effect = SystemExit()
        
        manager = start_all_services.PlatformManager()
        
        with patch('os.path.exists', return_value=True):
            with self.assertRaises(SystemExit):
                manager.run()
            mock_exit.assert_called_with(start_all_services._EXIT_FAILURE)
            
        mock_which.return_value = '/usr/bin/redis-server'
        mock_exit.reset_mock()
        
        with patch('os.path.exists', return_value=True):
            with patch('start_all_services.wait_for_service', return_value=False):
                with self.assertRaises(SystemExit):
                    manager.run()
                mock_exit.assert_called_with(start_all_services._EXIT_FAILURE)

    @patch('subprocess.run')
    @patch('subprocess.Popen')
    @patch('builtins.open', new_callable=mock_open)
    @patch('os.makedirs')
    @patch('socket.socket')
    @patch('shutil.which')
    @patch('os.path.exists')
    @patch('start_all_services.PlatformManager.clean_shutdown')
    def test_npm_install_flows(self, mock_clean_shutdown, mock_exists, mock_which, mock_socket, mock_makedirs, mock_file, mock_popen, mock_run):
        def mock_exists_fn(path):
            if "node_modules" in path:
                return False
            return True
        mock_exists.side_effect = mock_exists_fn
        mock_which.return_value = '/usr/bin/mock'
        
        mock_proc = MagicMock()
        mock_proc.pid = 9999
        mock_popen.return_value = mock_proc
        
        mock_run.return_value = MagicMock(returncode=0)
        mock_clean_shutdown.side_effect = SystemExit()
        
        manager = start_all_services.PlatformManager()
        
        with patch('start_all_services.wait_for_service', return_value=True):
            with patch('os.wait', side_effect=SystemExit()):
                with self.assertRaises(SystemExit):
                    manager.run()
        
        mock_run.assert_called_with(["npm", "install"], cwd=unittest.mock.ANY, check=True)
        
        mock_run.side_effect = subprocess.CalledProcessError(returncode=1, cmd="npm install")
        mock_clean_shutdown.reset_mock()
        
        with patch('start_all_services.wait_for_service', return_value=True):
            with self.assertRaises(SystemExit):
                manager.run()
            mock_clean_shutdown.assert_called_once()
            
        def mock_which_fn(cmd):
            if cmd == "npm":
                return None
            return '/usr/bin/mock'
        mock_which.side_effect = mock_which_fn
        mock_clean_shutdown.reset_mock()
        
        with self.assertRaises(SystemExit):
            manager.run()
        mock_clean_shutdown.assert_called_once()

    @patch('start_all_services.PlatformManager.clean_shutdown')
    @patch('subprocess.Popen')
    @patch('builtins.open', new_callable=mock_open)
    @patch('os.makedirs')
    @patch('socket.socket')
    @patch('shutil.which')
    def test_service_startup_failures(self, mock_which, mock_socket, mock_makedirs, mock_file, mock_popen, mock_clean_shutdown):
        mock_which.return_value = '/usr/bin/mock'
        mock_clean_shutdown.side_effect = SystemExit()
        
        manager = start_all_services.PlatformManager()
        with patch('os.path.exists', return_value=True):
            with patch('start_all_services.wait_for_service', return_value=False):
                with self.assertRaises(SystemExit):
                    manager.run()
                mock_clean_shutdown.assert_called_once()

    @patch('start_all_services.PlatformManager.clean_shutdown')
    @patch('subprocess.Popen')
    @patch('builtins.open', new_callable=mock_open)
    @patch('os.makedirs')
    @patch('socket.socket')
    @patch('shutil.which')
    @patch('os.WIFEXITED')
    @patch('os.WIFSIGNALED')
    @patch('os.WTERMSIG')
    def test_os_wait_various_signals(self, mock_wtermsig, mock_wifsignaled, mock_wifexited, mock_which, mock_socket, mock_makedirs, mock_file, mock_popen, mock_clean_shutdown):
        mock_which.return_value = '/usr/bin/mock'
        mock_clean_shutdown.side_effect = SystemExit()
        
        def mock_popen_fn(cmd, *args, **kwargs):
            proc = MagicMock()
            if any('//cmd/bff' in part for part in cmd):
                proc.pid = 9999
            elif any('//cmd/ems' in part for part in cmd):
                proc.pid = 9001
            elif any('//cmd/risk_node' in part for part in cmd):
                proc.pid = 9002
            elif any('//cmd/mdg' in part for part in cmd):
                proc.pid = 9003
            elif any('redis-server' in part for part in cmd):
                proc.pid = 9004
            else:
                proc.pid = 9005
            return proc
        mock_popen.side_effect = mock_popen_fn
        
        mock_sock_inst = MagicMock()
        mock_socket.return_value = mock_sock_inst
        
        manager = start_all_services.PlatformManager()
        
        mock_wifexited.return_value = False
        mock_wifsignaled.return_value = True
        mock_wtermsig.return_value = 9
        
        wait_calls = [(9999, 9)]
        def mock_wait():
            if wait_calls:
                return wait_calls.pop(0)
            raise ChildProcessError()
            
        with patch('os.wait', side_effect=mock_wait):
            with patch('os.path.exists', return_value=True):
                with patch('start_all_services.wait_for_service', return_value=True):
                    with self.assertRaises(SystemExit):
                        manager.run()
            mock_clean_shutdown.assert_called_once()
            
        mock_clean_shutdown.reset_mock()
        mock_wifsignaled.return_value = False
        wait_calls = [(9999, 42)]
        
        with patch('os.wait', side_effect=mock_wait):
            with patch('os.path.exists', return_value=True):
                with patch('start_all_services.wait_for_service', return_value=True):
                    with self.assertRaises(SystemExit):
                        manager.run()
            mock_clean_shutdown.assert_called_once()

        mock_clean_shutdown.reset_mock()
        interrupted = [True]
        def mock_wait_interrupted():
            if interrupted:
                interrupted.pop()
                raise InterruptedError()
            raise ChildProcessError()
            
        with patch('os.wait', side_effect=mock_wait_interrupted):
            with patch('os.path.exists', return_value=True):
                with patch('start_all_services.wait_for_service', return_value=True):
                    manager.run()
            mock_clean_shutdown.assert_not_called()

if __name__ == '__main__':
    unittest.main()
