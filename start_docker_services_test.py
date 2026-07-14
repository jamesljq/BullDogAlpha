#!/usr/bin/env python3
import os
import sys
import unittest
import subprocess
import datetime
from unittest.mock import patch, MagicMock

# Add current workspace directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import start_docker_services

class TestStartDockerServices(unittest.TestCase):
    def setUp(self):
        from absl import flags
        try:
            flags.FLAGS(['start_docker_services.py'])
        except Exception:
            pass

    @patch('shutil.which')
    @patch('sys.exit')
    def test_check_tool_dependencies(self, mock_exit, mock_which):
        orchestrator = start_docker_services.DockerOrchestrator()
        
        # 1. Tools exist
        mock_which.return_value = '/usr/bin/tool'
        orchestrator.check_tool_dependencies()
        mock_exit.assert_not_called()
        
        # 2. Tool missing
        mock_which.side_effect = lambda x: None if x == 'docker' else '/usr/bin/tool'
        orchestrator.check_tool_dependencies()
        mock_exit.assert_called_with(start_docker_services._EXIT_FAILURE)

    @patch('subprocess.run')
    @patch('sys.exit')
    def test_handle_shutdown(self, mock_exit, mock_run):
        orchestrator = start_docker_services.DockerOrchestrator()
        orchestrator.handle_shutdown(None, None)
        
        mock_run.assert_called_with(["docker", "compose", "down"], check=True)
        mock_exit.assert_called_once_with(start_docker_services._EXIT_SUCCESS)

    @patch('subprocess.run')
    @patch('shutil.copy2')
    @patch('os.makedirs')
    @patch('platform.machine')
    @patch('shutil.which')
    @patch('sys.exit')
    def test_orchestration_run(self, mock_exit, mock_which, mock_machine, mock_makedirs, mock_copy2, mock_run):
        mock_which.return_value = '/usr/bin/tool'
        
        # 1. Test arm64 path
        mock_machine.return_value = 'arm64'
        orchestrator = start_docker_services.DockerOrchestrator()
        
        with patch('os.path.exists', return_value=True):
            orchestrator.run()
            
        # Assert cross compilation with arm64 target
        mock_run.assert_any_call([
            "bazel", "build",
            "--platforms=@rules_go//go/toolchain:linux_arm64",
            "//cmd/ems", "//cmd/risk_node", "//cmd/mdg", "//cmd/bff"
        ], check=True)
        
        # Assert copy2 called for all services
        self.assertEqual(mock_copy2.call_count, 4)
        
        # 2. Test x86_64 path
        mock_run.reset_mock()
        mock_copy2.reset_mock()
        mock_machine.return_value = 'x86_64'
        
        with patch('os.path.exists', return_value=True):
            orchestrator.run()
            
        mock_run.assert_any_call([
            "bazel", "build",
            "--platforms=@rules_go//go/toolchain:linux_amd64",
            "//cmd/ems", "//cmd/risk_node", "//cmd/mdg", "//cmd/bff"
        ], check=True)

if __name__ == '__main__':
    unittest.main()
