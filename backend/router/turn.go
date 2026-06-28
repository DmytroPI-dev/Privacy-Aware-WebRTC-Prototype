package router

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	defaultTurnTTLSeconds = 600
	minTurnTTLSeconds     = 60
	maxTurnTTLSeconds     = 3600
)

type turnCredentialsResponse struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
	TTLSeconds int64    `json:"ttlSeconds"`
}

type turnConfig struct {
	sharedSecret string
	realm        string
	urls         []string
	ttlSeconds   int64
}

func handleTurnCredentials(c *gin.Context) {
	config, ok := turnConfigFromEnv()
	if !ok {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "turn unavailable"})
		return
	}

	response, err := generateTurnCredentials(config, time.Now().UTC())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "turn unavailable"})
		return
	}

	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, response)
}

func turnConfigFromEnv() (turnConfig, bool) {
	sharedSecret := strings.TrimSpace(os.Getenv("TURN_SHARED_SECRET"))
	realm := strings.TrimSpace(os.Getenv("TURN_REALM"))

	if sharedSecret == "" || realm == "" {
		return turnConfig{}, false
	}

	return turnConfig{
		sharedSecret: sharedSecret,
		realm:        realm,
		urls:         resolveTurnCredentialURLs(realm, os.Getenv("TURN_URLS")),
		ttlSeconds:   resolveTurnTTLSeconds(os.Getenv("TURN_TTL_SECONDS")),
	}, true
}

func resolveTurnCredentialURLs(realm string, rawURLs string) []string {
	urls := []string{}
	for value := range strings.SplitSeq(rawURLs, ",") {
		value = strings.TrimSpace(value)
		if value != "" {
			urls = append(urls, value)
		}
	}

	if len(urls) > 0 {
		return urls
	}

	return []string{"turns:" + realm + ":443?transport=tcp"}
}

func resolveTurnTTLSeconds(rawValue string) int64 {
	ttlSeconds := int64(defaultTurnTTLSeconds)
	if value, err := strconv.ParseInt(strings.TrimSpace(rawValue), 10, 64); err == nil {
		ttlSeconds = value
	}

	if ttlSeconds < minTurnTTLSeconds {
		return minTurnTTLSeconds
	}

	if ttlSeconds > maxTurnTTLSeconds {
		return maxTurnTTLSeconds
	}

	return ttlSeconds
}

func generateTurnCredentials(config turnConfig, now time.Time) (turnCredentialsResponse, error) {
	sessionIDBytes := make([]byte, 16)
	if _, err := rand.Read(sessionIDBytes); err != nil {
		return turnCredentialsResponse{}, err
	}

	expiry := now.Add(time.Duration(config.ttlSeconds) * time.Second).Unix()
	username := strconv.FormatInt(expiry, 10) + ":" + hex.EncodeToString(sessionIDBytes)
	credential := signTurnUsername(config.sharedSecret, username)

	return turnCredentialsResponse{
		URLs:       config.urls,
		Username:   username,
		Credential: credential,
		TTLSeconds: config.ttlSeconds,
	}, nil
}

func signTurnUsername(sharedSecret string, username string) string {
	mac := hmac.New(sha1.New, []byte(sharedSecret))
	mac.Write([]byte(username))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}
