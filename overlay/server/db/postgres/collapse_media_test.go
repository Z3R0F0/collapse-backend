//go:build postgres

package postgres

import (
	"strings"
	"testing"
)

func TestCollapseMediaMetadataIsBounded(t *testing.T) {
	data, inline := mediaData("IM", map[string]any{
		"ref": "/v0/file/s/synthetic.png", "val": strings.Repeat("x", 100000),
		"preview": strings.Repeat("p", 4097), "name": "synthetic.png",
		"spoiler": map[string]any{"txt": "private"}, "arbitrary": "omitted",
		"size": float64(123), "width": float64(40), "height": float64(-1),
	})
	if !inline || data["ref"] == nil || data["name"] == nil || data["size"] != float64(123) {
		t.Fatal("lost usable metadata")
	}
	for _, key := range []string{"val", "preview", "spoiler", "arbitrary", "height"} {
		if _, ok := data[key]; ok {
			t.Fatalf("unbounded/private field retained: %s", key)
		}
	}
}

func TestCollapseMediaThumbnailIsReferenceOnlyAndBounded(t *testing.T) {
	for _, test := range []struct {
		kind, ref, value string
		want             bool
	}{
		{"IM", "/v0/file/s/image", "aGVsbG8=", true},
		{"IM", "/v0/file/s/image", strings.Repeat("A", 16384), true},
		{"IM", "/v0/file/s/image", strings.Repeat("A", 16388), false},
		{"IM", "/v0/file/s/image", "not base64!", false},
		{"IM", "", "aGVsbG8=", false},
		{"AU", "/v0/file/s/voice", "aGVsbG8=", false},
	} {
		data, _ := mediaData(test.kind, map[string]any{"ref": test.ref, "val": test.value})
		if (data["preview"] != nil) != test.want || data["val"] != nil {
			t.Fatal("unexpected thumbnail projection")
		}
	}
}

func TestCollapseMediaKindCannotBecomeSQL(t *testing.T) {
	if _, err := mediaFrom("visual' OR true --"); err == nil {
		t.Fatal("accepted arbitrary predicate")
	}
	for _, kind := range []string{"visual", "audio", "files"} {
		query, err := mediaFrom(kind)
		if err != nil || !strings.Contains(query, "collapse_media_has_v1(m.content::jsonb, '"+kind+"')") {
			t.Fatal("query must match its constant partial-index predicate")
		}
	}
}
