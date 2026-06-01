package order_test

import (
	"testing"

	"buf.build/go/protovalidate"
	pb "bulldog_alpha/proto/order"
)

func TestOrderValidation(t *testing.T) {
	v, err := protovalidate.New()
	if err != nil {
		t.Fatalf("failed to initialize validator: %v", err)
	}

	tests := []struct {
		name    string
		req     *pb.OrderRequest
		wantErr bool
	}{
		{
			name: "valid order",
			req: &pb.OrderRequest{
				OrderId:       "123",
				Symbol:        "AAPL",
				Price:         150.0,
				Quantity:      10,
				Side:          pb.OrderSide_BUY,
				Type:          pb.OrderType_LIMIT,
				CorrelationId: "corr-1",
			},
			wantErr: false,
		},
		{
			name: "invalid symbol - lowercase",
			req: &pb.OrderRequest{
				OrderId:       "123",
				Symbol:        "aapl",
				Price:         150.0,
				Quantity:      10,
				Side:          pb.OrderSide_BUY,
				Type:          pb.OrderType_LIMIT,
				CorrelationId: "corr-2",
			},
			wantErr: true,
		},
		{
			name: "invalid symbol - empty",
			req: &pb.OrderRequest{
				OrderId:       "123",
				Symbol:        "",
				Price:         150.0,
				Quantity:      10,
				Side:          pb.OrderSide_BUY,
				Type:          pb.OrderType_LIMIT,
				CorrelationId: "corr-3",
			},
			wantErr: true,
		},
		{
			name: "invalid price - negative",
			req: &pb.OrderRequest{
				OrderId:       "123",
				Symbol:        "AAPL",
				Price:         -10.0,
				Quantity:      10,
				Side:          pb.OrderSide_BUY,
				Type:          pb.OrderType_LIMIT,
				CorrelationId: "corr-4",
			},
			wantErr: true,
		},
		{
			name: "invalid quantity - zero",
			req: &pb.OrderRequest{
				OrderId:       "123",
				Symbol:        "AAPL",
				Price:         150.0,
				Quantity:      0,
				Side:          pb.OrderSide_BUY,
				Type:          pb.OrderType_LIMIT,
				CorrelationId: "corr-5",
			},
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := v.Validate(tc.req)
			if tc.wantErr {
				if err == nil {
					t.Error("expected validation error, got none")
				} else {
					t.Logf("got expected error: %v", err)
				}
			} else {
				if err != nil {
					t.Errorf("expected no validation error, got: %v", err)
				}
			}
		})
	}
}
