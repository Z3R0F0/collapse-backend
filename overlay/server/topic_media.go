package main

import (
	"github.com/tinode/chat/server/store"
	"github.com/tinode/chat/server/store/types"
)

// Runs inside the existing attached-topic actor, with its canonical P2P name,
// authenticated identity, permissions and serialized deletion/access changes.
func (t *Topic) replyGetMedia(msg *ClientComMessage, uid types.Uid, asChan bool) {
	now := types.TimeNow()
	pud, exists := t.perUser[uid]
	if !exists || !(pud.modeWant & pud.modeGiven).IsReader() || asChan ||
		(t.cat != types.TopicCatP2P && t.cat != types.TopicCatGrp && t.cat != types.TopicCatSlf) {
		msg.sess.queueOut(ErrPermissionDeniedReply(msg, now))
		return
	}
	query := msg.Get.Media
	if query == nil || (query.Kind != "visual" && query.Kind != "audio" && query.Kind != "files") {
		msg.sess.queueOut(ErrMalformedReply(msg, now))
		return
	}
	q := *query
	if q.Limit == 0 {
		q.Limit = 24
	}
	cursors := 0
	for _, c := range []*types.MediaCursor{q.Before, q.After, q.Around} {
		if c == nil {
			continue
		}
		cursors++
		if c.Seq < 1 || c.Key < 0 || c.Key > 131072 {
			msg.sess.queueOut(ErrMalformedReply(msg, now))
			return
		}
	}
	if cursors > 1 || q.Limit < 1 || q.Limit > 40 || (q.Snapshot != nil && *q.Snapshot < 0) {
		msg.sess.queueOut(ErrMalformedReply(msg, now))
		return
	}
	head := t.lastID
	if q.Snapshot != nil && *q.Snapshot < head {
		head = *q.Snapshot
	}
	q.Snapshot = &head
	page, err := store.GetMedia(t.name, uid, q)
	if err != nil {
		msg.sess.queueOut(decodeStoreErrorExplicitTs(err, msg.Id, msg.Original, now, msg.Timestamp, nil))
		return
	}
	page.DelID = pud.delID
	msg.sess.queueOut(&ServerComMessage{Meta: &MsgServerMeta{
		Id: msg.Id, Topic: t.original(uid), Timestamp: &now, Media: page,
	}})
}
