//go:build postgres

package postgres

import (
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/tinode/chat/server/store"
	t "github.com/tinode/chat/server/store/types"
)

//go:embed collapse_media.sql
var mediaSchema string

var mediaReadOptions = pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}

// The first startup builds indexes over existing rows atomically. Concurrent
// server startups serialize only this migration, not normal media reads.
func (a *adapter) ensureMediaSchema() error {
	ctx, cancel := a.getContextForTx()
	if cancel != nil {
		defer cancel()
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(1129270348, 1)"); err != nil {
		return err
	}
	var present bool
	if err = tx.QueryRow(ctx, "SELECT to_regprocedure('public.collapse_media_items_v1(jsonb)') IS NOT NULL").Scan(&present); err != nil {
		return err
	}
	if !present {
		if _, err = tx.Exec(ctx, mediaSchema); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Fixed enum literals deliberately match the partial-index predicates. Only
// topic/user/cursor values are parameters; no client SQL/JSONPath is accepted.
func mediaFrom(kind string) (string, error) {
	if kind != "visual" && kind != "audio" && kind != "files" {
		return "", t.ErrMalformed
	}
	return ` FROM messages m CROSS JOIN LATERAL public.collapse_media_items_v1(m.content::jsonb) e
 WHERE m.topic=$1 AND m.delid=0 AND m.seqid<=$3
 AND public.collapse_media_has_v1(m.content::jsonb, '` + kind + `') AND e.kind='` + kind + `'
 AND NOT EXISTS(SELECT 1 FROM dellog d WHERE d.topic=m.topic AND d.deletedfor=$2
   AND m.seqid>=d.low AND m.seqid<d.hi)`, nil
}

func (a *adapter) MediaGet(topic string, user t.Uid, q t.MediaQuery) (*t.MediaPage, error) {
	base, err := mediaFrom(q.Kind)
	if err != nil {
		return nil, err
	}
	if q.Snapshot == nil || q.Limit < 1 || q.Limit > 40 {
		return nil, t.ErrMalformed
	}
	ctx, cancel := a.getContext()
	if cancel != nil {
		defer cancel()
	}
	// A single repeatable-read snapshot keeps page edges and rows consistent.
	tx, err := a.db.BeginTx(ctx, mediaReadOptions)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	args := []any{topic, store.DecodeUid(user), *q.Snapshot}
	fetch := func(cursor *t.MediaCursor, relation string, ascending bool, limit int) ([]t.MediaItem, error) {
		query := `SELECT m.seqid,e.key,e.entity,m."from",m.createdat,
 CASE WHEN m."from"=$2 AND json_typeof(m.head->'x-client-id')='string'
 THEN m.head->>'x-client-id' ELSE NULL END` + base
		params := append([]any{}, args...)
		if cursor != nil {
			query += " AND (m.seqid,e.key) " + relation + " ($4,$5)"
			params = append(params, cursor.Seq, cursor.Key)
		}
		order := "DESC"
		if ascending {
			order = "ASC"
		}
		query += fmt.Sprintf(" ORDER BY m.seqid %s,e.key %s LIMIT $%d", order, order, len(params)+1)
		params = append(params, limit)
		rows, err := tx.Query(ctx, query, params...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		items := make([]t.MediaItem, 0, limit)
		for rows.Next() {
			var item t.MediaItem
			var raw []byte
			var sender int64
			var clientID *string
			if err := rows.Scan(&item.Seq, &item.Key, &raw, &sender, &item.Ts, &clientID); err != nil {
				return nil, err
			}
			var entity map[string]any
			if err := json.Unmarshal(raw, &entity); err != nil {
				return nil, err
			}
			item.Type, _ = entity["tp"].(string)
			item.From = store.EncodeUid(sender).UserId()
			item.Data, item.Inline = mediaData(item.Type, entity["data"])
			if clientID != nil && len(*clientID) <= 256 {
				item.ClientID = *clientID
			}
			items = append(items, item)
		}
		return items, rows.Err()
	}
	page := &t.MediaPage{Items: []t.MediaItem{}, Snapshot: *q.Snapshot}
	if q.Around != nil {
		anchor, err := fetch(q.Around, "=", false, 1)
		if err != nil {
			return nil, err
		}
		found := len(anchor) != 0
		page.AnchorFound = &found
		newer, err := fetch(q.Around, ">", true, q.Limit/2)
		if err != nil {
			return nil, err
		}
		older, err := fetch(q.Around, "<", false, q.Limit-len(anchor)-len(newer))
		if err != nil {
			return nil, err
		}
		page.Items = append(append(newer, anchor...), older...)
	} else {
		cursor, relation, ascending := q.Before, "<", false
		if q.After != nil {
			cursor, relation, ascending = q.After, ">", true
		}
		page.Items, err = fetch(cursor, relation, ascending, q.Limit)
		if err != nil {
			return nil, err
		}
	}
	sort.Slice(page.Items, func(i, j int) bool {
		a, b := page.Items[i], page.Items[j]
		return a.Seq > b.Seq || (a.Seq == b.Seq && a.Key > b.Key)
	})
	edge := q.Before
	if q.After != nil {
		edge = q.After
	}
	if q.Around != nil {
		edge = q.Around
	}
	olderEdge, newerEdge := edge, edge
	if len(page.Items) > 0 {
		first, last := page.Items[0], page.Items[len(page.Items)-1]
		olderEdge = &t.MediaCursor{Seq: last.Seq, Key: last.Key}
		newerEdge = &t.MediaCursor{Seq: first.Seq, Key: first.Key}
	}
	if olderEdge != nil {
		items, err := fetch(olderEdge, "<", false, 1)
		if err != nil {
			return nil, err
		}
		page.HasOlder = len(items) > 0
	}
	if newerEdge != nil {
		items, err := fetch(newerEdge, ">", true, 1)
		if err != nil {
			return nil, err
		}
		page.HasNewer = len(items) > 0
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return page, nil
}

// Do not ship original messages, large binary values, hidden fragments, arbitrary
// headers, or metadata objects in a grid response. Inline bytes are fetched only
// when the viewer explicitly opens that single message through stock history.
func mediaData(kind string, raw any) (map[string]any, bool) {
	data, _ := raw.(map[string]any)
	result := make(map[string]any)
	for key, limit := range map[string]int{"ref": 2048, "preref": 2048, "name": 256, "mime": 128, "premime": 128, "preview": 4096} {
		if value, ok := data[key].(string); ok && len(value) <= limit {
			result[key] = value
		}
	}
	for _, key := range []string{"width", "height", "size", "duration"} {
		if value, ok := data[key].(float64); ok && value >= 0 && !math.IsInf(value, 0) && !math.IsNaN(value) {
			result[key] = value
		}
	}
	// Stock Drafty stores an uploaded image's small thumbnail in val. Return
	// only a bounded, valid base64 preview, never the binary field itself or an
	// inline-only original. The image reference remains the canonical source.
	if kind == "IM" && result["preview"] == nil && result["ref"] != nil && result["ref"] != "" {
		if value, ok := data["val"].(string); ok && len(value) > 0 && len(value) <= 16384 {
			if decoded, err := base64.StdEncoding.DecodeString(value); err == nil && len(decoded) > 0 {
				result["preview"] = value
			}
		}
	}
	inline := false
	switch value := data["val"].(type) {
	case string:
		inline = value != ""
	case []any:
		inline = len(value) > 0
	}
	return result, inline
}
