package tunnel

import (
	"context"
	"testing"
	"time"
)

func TestUserspaceTunnelCarriesPayloadAndFailsClosed(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := SelfTest(ctx); err != nil {
		t.Fatal(err)
	}
	if err := WrongKeyFails(ctx); err != nil {
		t.Fatal(err)
	}
}
