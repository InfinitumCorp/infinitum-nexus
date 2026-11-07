package tor

import (
	"context"
	"io"
	"net"
	"testing"
	"time"
)

func TestProbeSOCKS(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 3)
				_, _ = io.ReadFull(c, buf)
				_, _ = c.Write([]byte{0x05, 0x00})
			}(conn)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := ProbeSOCKS(ctx, ln.Addr().String()); err != nil {
		t.Fatal(err)
	}
	avail, err := Inspect(ctx, ln.Addr().String(), "127.0.0.1:1", "127.0.0.1:1")
	if err != nil {
		t.Fatal(err)
	}
	if !avail.SOCKS || avail.Transparent || avail.Coverage != "socks-fail-closed" {
		t.Fatalf("availability %+v", avail)
	}
	if _, err := Inspect(ctx, "127.0.0.1:1", "", ""); err == nil {
		t.Fatal("closed port should fail")
	}
}
