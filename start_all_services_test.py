#!/usr/bin/env python3
import os
import sys
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
            with patch('time.sleep', side_effect=mock_sleep):
                with self.assertRaises(SystemExit):
                    start_all_services.main(['start_all_services.py'])
        
        # Assert processes started
        self.assertTrue(mock_popen.called)
        calls = [c[0][0] for c in mock_popen.call_args_list]
        
        self.assertIn(['redis-server'], calls)
        self.assertTrue(any('//cmd/ems' in cmd for cmd in calls))
        self.assertTrue(any('//cmd/risk_node' in cmd for cmd in calls))
        self.assertTrue(any('//cmd/mdg' in cmd for cmd in calls))
        self.assertTrue(any('//cmd/bff' in cmd for cmd in calls))
        self.assertIn(['npm', 'start'], calls)

if __name__ == '__main__':
    unittest.main()
