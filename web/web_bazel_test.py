import os
import unittest
import json

class TestWebAssets(unittest.TestCase):
    def setUp(self):
        self.web_dir = os.path.dirname(os.path.abspath(__file__))

    def test_package_json(self):
        pkg_path = os.path.join(self.web_dir, "package.json")
        self.assertTrue(os.path.exists(pkg_path), "package.json should exist")
        
        with open(pkg_path, "r") as f:
            data = json.load(f)
        
        self.assertEqual(data["name"], "bulldog-alpha-console")
        self.assertIn("react", data["dependencies"])
        self.assertIn("typescript", data["devDependencies"])

    def test_react_app_sources(self):
        app_path = os.path.join(self.web_dir, "src", "App.tsx")
        self.assertTrue(os.path.exists(app_path), "App.tsx should exist")

        with open(app_path, "r") as f:
            content = f.read()

        # Check essential UI component triggers
        self.assertIn("PAUSE TRADING", content)
        self.assertIn("PANIC LIQUIDATE", content)
        self.assertIn("SAFE RESUME WIZARD", content)
        self.assertIn("Microservices Health & Topology", content)
        self.assertIn("WebSocket", content)
        self.assertIn("api/circuit", content)
        self.assertIn("api/config", content)
        self.assertIn("api/shutdown", content)
        self.assertIn("SHUTDOWN ALL SERVICES", content)

    def test_react_tests(self):
        test_path = os.path.join(self.web_dir, "src", "App.test.tsx")
        self.assertTrue(os.path.exists(test_path), "App.test.tsx should exist")

        with open(test_path, "r") as f:
            content = f.read()
        self.assertIn("renders dashboard header and circuit status", content)

if __name__ == "__main__":
    unittest.main()
