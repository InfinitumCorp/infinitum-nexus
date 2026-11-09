// Copyright Infinitum Corporation.
// X25519 key generation follows WireGuard's Noise key clamping.
// The handshake itself is wireguard-go.

package tunnel

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"

	"golang.org/x/crypto/curve25519"
)

var ErrPrivateKey = errors.New("private key must be 32 non-zero bytes")

func newPrivateKey(r io.Reader) ([32]byte, error) {
	var key [32]byte
	if _, err := io.ReadFull(r, key[:]); err != nil {
		return [32]byte{}, err
	}
	clamp(&key)
	if key == ([32]byte{}) {
		return [32]byte{}, ErrPrivateKey
	}
	return key, nil
}

func clamp(key *[32]byte) {
	key[0] &= 248
	key[31] = (key[31] & 127) | 64
}

func publicFrom(private [32]byte) ([32]byte, error) {
	clamp(&private)
	out, err := curve25519.X25519(private[:], curve25519.Basepoint)
	if err != nil {
		return [32]byte{}, err
	}
	var pub [32]byte
	copy(pub[:], out)
	return pub, nil
}

// MintHex returns disposable hex keys. Callers must not log or store them.
func MintHex() (privateHex, publicHex string, err error) {
	priv, pub, err := generateKey()
	if err != nil {
		return "", "", err
	}
	return keyHex(priv), keyHex(pub), nil
}

func generateKey() (private, public [32]byte, err error) {
	private, err = newPrivateKey(rand.Reader)
	if err != nil {
		return [32]byte{}, [32]byte{}, err
	}
	public, err = publicFrom(private)
	return private, public, err
}

func keyHex(key [32]byte) string {
	return hex.EncodeToString(key[:])
}
