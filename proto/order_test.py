import unittest
from proto import order_pb2
from proto import market_data_pb2

class TestOrderProto(unittest.TestCase):
    def test_order_fields(self):
        req = order_pb2.OrderRequest()
        req.order_id = "123"
        req.symbol = "AAPL"
        req.price = 150.0
        req.quantity = 10.0
        req.side = order_pb2.OrderSide.BUY
        req.type = order_pb2.OrderType.LIMIT
        req.correlation_id = "corr-123"
        
        self.assertEqual(req.order_id, "123")
        self.assertEqual(req.symbol, "AAPL")
        self.assertEqual(req.price, 150.0)
        self.assertEqual(req.quantity, 10.0)
        self.assertEqual(req.side, order_pb2.OrderSide.BUY)
        self.assertEqual(req.type, order_pb2.OrderType.LIMIT)
        self.assertEqual(req.correlation_id, "corr-123")

    def test_market_data_fields(self):
        tick = market_data_pb2.EquityTick()
        tick.symbol = "AAPL"
        tick.price = 150.0
        tick.size = 100.0
        tick.timestamp = 1600000000000
        tick.correlation_id = "corr-456"
        
        self.assertEqual(tick.symbol, "AAPL")
        self.assertEqual(tick.price, 150.0)
        self.assertEqual(tick.size, 100.0)
        self.assertEqual(tick.timestamp, 1600000000000)
        self.assertEqual(tick.correlation_id, "corr-456")

if __name__ == "__main__":
    unittest.main()
