package secret

import (
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"

	"golang.org/x/crypto/nacl/secretbox"
)

const (
	KeySize   = 32
	NonceSize = 24
)

type Secret struct {
	plaintext []byte
}

func NewSecret(plaintext []byte) Secret {
	cp := make([]byte, len(plaintext))
	copy(cp, plaintext)
	return Secret{plaintext: cp}
}

func (s Secret) Bytes() []byte {
	cp := make([]byte, len(s.plaintext))
	copy(cp, s.plaintext)
	return cp
}

func (s Secret) String() string {
	return "***"
}

func (s Secret) MarshalJSON() ([]byte, error) {
	return []byte(`"***"`), nil
}

func Encrypt(plaintext, key []byte) ([]byte, error) {
	if len(key) != KeySize {
		return nil, fmt.Errorf("secret: key must be %d bytes", KeySize)
	}

	var nonce [NonceSize]byte
	if _, err := io.ReadFull(rand.Reader, nonce[:]); err != nil {
		return nil, fmt.Errorf("secret: generate nonce: %w", err)
	}

	var k [KeySize]byte
	copy(k[:], key)

	sealed := secretbox.Seal(nonce[:], plaintext, &nonce, &k)
	return sealed, nil
}

func Decrypt(ciphertext, key []byte) ([]byte, error) {
	if len(key) != KeySize {
		return nil, fmt.Errorf("secret: key must be %d bytes", KeySize)
	}
	if len(ciphertext) < NonceSize+secretbox.Overhead {
		return nil, errors.New("secret: ciphertext too short")
	}

	var nonce [NonceSize]byte
	copy(nonce[:], ciphertext[:NonceSize])

	var k [KeySize]byte
	copy(k[:], key)

	opened, ok := secretbox.Open(nil, ciphertext[NonceSize:], &nonce, &k)
	if !ok {
		return nil, errors.New("secret: decryption failed")
	}
	return opened, nil
}

func LoadMasterKey(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("secret: read master key: %w", err)
	}
	if len(data) != KeySize {
		return nil, fmt.Errorf("secret: master key must be %d bytes, got %d", KeySize, len(data))
	}
	return data, nil
}

func GenerateKey() ([]byte, error) {
	key := make([]byte, KeySize)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, fmt.Errorf("secret: generate key: %w", err)
	}
	return key, nil
}
