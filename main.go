// main.go
package main

import (
	"context"
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

type App struct {
	ctx context.Context
}

func NewApp() *App {
	return &App{}
}

// Wails가 시작될 때 호출되어 백그라운드에서 P2P 세션을 초기화합니다.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	go a.startupP2P()
}

func main() {
	app := NewApp()
	err := wails.Run(&options.App{
		Title:  "P2P Streamer",
		Width:  1024,
		Height: 768,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		OnStartup: app.startup,
		Bind: []interface{}{
			app,
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
