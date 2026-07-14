#!/usr/bin/env python3
import os
import sys
import datetime
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
        
        # Save old values
        old_processes = start_all_services.processes
        old_log_files = start_all_services.log_files
        
        try:
            start_all_services.processes = {"MockService": mock_proc}
            start_all_services.log_files = [mock_file]
            
            start_all_services.clean_shutdown(None, None)
            
            mock_proc.terminate.assert_called_once()
            mock_file.close.assert_called_once()
            mock_exit.assert_called_once_with(0)
        finally:
            start_all_services.processes = old_processes
            start_all_services.log_files = old_log_files

    @patch('start_all_services.clean_shutdown')
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

if __name__ == '__main__':
    unittest.main()
