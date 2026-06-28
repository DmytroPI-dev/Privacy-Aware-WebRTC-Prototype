package main

import (
	"log"
	"messenger-backend/router"
	"os"
)

func main() {
	r, err := router.SetupRouter()
	if err != nil {
		log.Fatal(err)
	}

	addr := os.Getenv("BACKEND_ADDR")
	if addr == "" {
		port := os.Getenv("PORT")
		if port == "" {
			port = "8080"
		}
		addr = "127.0.0.1:" + port
	}

	if err := r.Run(addr); err != nil {
		log.Fatal(err)
	}
}
