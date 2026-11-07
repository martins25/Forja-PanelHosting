package secret

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestSecretString(t *testing.T) {
	s := NewSecret([]byte("super-secret-token"))
	if s.String() != "***" {
		t.Errorf("String() = %q, want '***'", s.String())
	}
	if fmt.Sprintf("%s", s) != "***" {
		t.Errorf("Sprintf = %q, want '***'", fmt.Sprintf("%s", s))
	}
}

func TestSecretMarshalJSON(t *testing.T) {
	s := NewSecret([]byte("token-123"))

	type wrapper struct {
		Token Secret `json:"token"`
	}
	data, err := json.Marshal(wrapper{Token: s})
	if err != nil {
		t.Fatal(err)
	}
	expected := `{"token":"***"}`
	if string(data) != expected {
		t.Errorf("JSON = %s, want %s", data, expected)
	}
}

func TestSecretBytes(t *testing.T) {
	original := []byte("my-secret")
	s := NewSecret(original)
	got := s.Bytes()

	if string(got) != "my-secret" {
		t.Errorf("Bytes() = %q, want 'my-secret'", got)
	}

	got[0] = 'X'
	if string(s.Bytes()) != "my-secret" {
		t.Error("modifying Bytes() result should not affect internal state")
	}
}

func TestEncryptDecrypt(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}

	plaintext := []byte("hello, forja!")
	ciphertext, err := Encrypt(plaintext, key)
	if err != nil {
		t.Fatal(err)
	}

	if string(ciphertext) == string(plaintext) {
		t.Error("ciphertext should differ from plaintext")
	}

	decrypted, err := Decrypt(ciphertext, key)
	if err != nil {
		t.Fatal(err)
	}

	if string(decrypted) != string(plaintext) {
		t.Errorf("decrypted = %q, want %q", decrypted, plaintext)
	}
}

func TestDecryptWrongKey(t *testing.T) {
	key1, _ := GenerateKey()
	key2, _ := GenerateKey()

	ciphertext, _ := Encrypt([]byte("secret"), key1)
	_, err := Decrypt(ciphertext, key2)
	if err == nil {
		t.Error("decryption with wrong key should fail")
	}
}

func TestDecryptTooShort(t *testing.T) {
	key, _ := GenerateKey()
	_, err := Decrypt([]byte("short"), key)
	if err == nil {
		t.Error("decrypting too-short ciphertext should fail")
	}
}

func TestEncryptBadKeySize(t *testing.T) {
	_, err := Encrypt([]byte("data"), []byte("short-key"))
	if err == nil {
		t.Error("Encrypt with wrong key size should fail")
	}
}

func TestLoadMasterKey(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "master.key")

	key, _ := GenerateKey()
	if err := os.WriteFile(path, key, 0o600); err != nil {
		t.Fatal(err)
	}

	loaded, err := LoadMasterKey(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded) != KeySize {
		t.Errorf("key length = %d, want %d", len(loaded), KeySize)
	}
}

func TestLoadMasterKeyWrongSize(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "master.key")
	if err := os.WriteFile(path, []byte("too-short"), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := LoadMasterKey(path)
	if err == nil {
		t.Error("LoadMasterKey with wrong size should fail")
	}
}
