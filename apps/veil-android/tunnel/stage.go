// Copyright Infinitum Corporation.
// Stage errors are the only failure text the Android process may surface.
// Each string is a fixed token. None of them include a key, an endpoint,
// a config line, or a syscall message.

package tunnel

import "errors"

var (
	ErrStageDup     = errors.New("stage:dup")
	ErrStageKey     = errors.New("stage:key")
	ErrStageListen  = errors.New("stage:listen")
	ErrStagePort    = errors.New("stage:port")
	ErrStageConfig  = errors.New("stage:config")
	ErrStageProtect = errors.New("stage:protect")
	ErrStageTun     = errors.New("stage:tun")
	ErrStageUp      = errors.New("stage:up")
	ErrStageCIDR    = errors.New("stage:cidr")
)
