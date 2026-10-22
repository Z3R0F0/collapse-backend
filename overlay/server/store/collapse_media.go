package store

import "github.com/tinode/chat/server/store/types"

// Optional adapter capability: the upstream Adapter contract remains unchanged.
type mediaReader interface {
	MediaGet(string, types.Uid, types.MediaQuery) (*types.MediaPage, error)
}

func GetMedia(topic string, user types.Uid, query types.MediaQuery) (*types.MediaPage, error) {
	reader, ok := adp.(mediaReader)
	if !ok {
		return nil, types.ErrUnsupported
	}
	return reader.MediaGet(topic, user, query)
}
