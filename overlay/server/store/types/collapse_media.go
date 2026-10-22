package types

import "time"

// MediaCursor identifies an original Drafty entity, not a position in a page.
type MediaCursor struct {
	Seq int `json:"seq"`
	Key int `json:"key"`
}

type MediaQuery struct {
	Kind     string       `json:"kind"`
	Before   *MediaCursor `json:"before,omitempty"`
	After    *MediaCursor `json:"after,omitempty"`
	Around   *MediaCursor `json:"around,omitempty"`
	Limit    int          `json:"limit,omitempty"`
	Snapshot *int         `json:"snapshot,omitempty"`
}

type MediaItem struct {
	Seq      int            `json:"seq"`
	Key      int            `json:"key"`
	Type     string         `json:"type"`
	Data     map[string]any `json:"data"`
	From     string         `json:"from"`
	Ts       time.Time      `json:"ts"`
	Inline   bool           `json:"inline,omitempty"`
	ClientID string         `json:"clientId,omitempty"`
}

type MediaPage struct {
	Items       []MediaItem `json:"items"`
	HasOlder    bool        `json:"hasOlder"`
	HasNewer    bool        `json:"hasNewer"`
	Snapshot    int         `json:"snapshot"`
	DelID       int         `json:"delId"`
	AnchorFound *bool       `json:"anchorFound,omitempty"`
}
