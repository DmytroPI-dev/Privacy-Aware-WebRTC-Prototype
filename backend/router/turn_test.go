package router

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestGenerateTurnCredentialsSignsExpiringUsername(t *testing.T) {
	now := time.Unix(1715874600, 0)
	config := turnConfig{
		sharedSecret: "test-secret",
		realm:        "turn.example.com",
		urls:         []string{"turns:turn.example.com:443?transport=tcp"},
		ttlSeconds:   600,
	}

	credentials, err := generateTurnCredentials(config, now)
	if err != nil {
		t.Fatalf("generateTurnCredentials() error = %v", err)
	}

	if credentials.TTLSeconds != 600 {
		t.Fatalf("TTLSeconds = %d, want 600", credentials.TTLSeconds)
	}
	if len(credentials.URLs) != 1 || credentials.URLs[0] != config.urls[0] {
		t.Fatalf("URLs = %#v, want %#v", credentials.URLs, config.urls)
	}

	parts := strings.Split(credentials.Username, ":")
	if len(parts) != 2 {
		t.Fatalf("Username = %q, want expiry:session", credentials.Username)
	}

	expiry, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		t.Fatalf("expiry parse error = %v", err)
	}
	if expiry != now.Add(600*time.Second).Unix() {
		t.Fatalf("expiry = %d, want %d", expiry, now.Add(600*time.Second).Unix())
	}
	if len(parts[1]) != 32 {
		t.Fatalf("session id length = %d, want 32", len(parts[1]))
	}

	mac := hmac.New(sha1.New, []byte(config.sharedSecret))
	mac.Write([]byte(credentials.Username))
	expectedCredential := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if credentials.Credential != expectedCredential {
		t.Fatalf("Credential = %q, want %q", credentials.Credential, expectedCredential)
	}
}

func TestResolveTurnTTLSecondsBoundsValues(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want int64
	}{
		{name: "default", raw: "", want: defaultTurnTTLSeconds},
		{name: "valid", raw: "900", want: 900},
		{name: "minimum", raw: "10", want: minTurnTTLSeconds},
		{name: "maximum", raw: "99999", want: maxTurnTTLSeconds},
		{name: "invalid", raw: "nope", want: defaultTurnTTLSeconds},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := resolveTurnTTLSeconds(test.raw)
			if got != test.want {
				t.Fatalf("resolveTurnTTLSeconds(%q) = %d, want %d", test.raw, got, test.want)
			}
		})
	}
}

func TestResolveTurnCredentialURLs(t *testing.T) {
	got := resolveTurnCredentialURLs("turn.example.com", "")
	if len(got) != 1 || got[0] != "turns:turn.example.com:443?transport=tcp" {
		t.Fatalf("default URLs = %#v", got)
	}

	got = resolveTurnCredentialURLs("turn.example.com", " turns:a:443?transport=tcp,turn:b:3478?transport=udp ")
	want := []string{"turns:a:443?transport=tcp", "turn:b:3478?transport=udp"}
	if len(got) != len(want) {
		t.Fatalf("URLs length = %d, want %d: %#v", len(got), len(want), got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("URLs[%d] = %q, want %q", index, got[index], want[index])
		}
	}
}
