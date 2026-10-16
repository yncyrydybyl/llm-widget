import { describe, expect, it } from "vitest";
import type { IRoomEvent } from "matrix-widget-api";
import { NO_DONATION, PRESENCE_TTL_MS, PRESENCE_TYPE, Roster, toPresence, type Donation } from "./presence";

const NOW = 1_000_000_000;
const announce = (
    sender: string,
    instance: string,
    ts: number,
    extra: Record<string, unknown> = {},
): IRoomEvent =>
    ({
        type: PRESENCE_TYPE,
        event_id: `$${instance}-${ts}`,
        sender,
        room_id: "!r",
        origin_server_ts: ts,
        unsigned: {},
        content: { instance, device: `dev-${instance}`, online: true, model: null, everyone: false, prefix: "!ai", ...extra },
    }) as IRoomEvent;

const gave = (answers: number, gpuMs: number): Donation => ({ ...NO_DONATION, answers, gpuMs, promptTokens: answers * 100, completionTokens: answers * 10 });

function roster(...events: IRoomEvent[]): Roster {
    const r = new Roster();
    for (const ev of events) r.add(toPresence(ev)!);
    return r;
}

describe("presence", () => {
    it("ignores other events and malformed content", () => {
        expect(toPresence({ ...announce("@a:x", "i", 1), type: "m.room.message" })).toBeNull();
        expect(toPresence(announce("@a:x", "", 1))).toBeNull();
        expect(toPresence(announce("@a:x", "i", 1, { donated: { answers: -3, gpuMs: "lots" } }))!.donated).toEqual(NO_DONATION);
    });

    it("counts open widgets and who can answer whom", () => {
        const s = roster(
            announce("@alice:x", "a1", NOW, { model: "Qwen" }),
            announce("@bob:x", "b1", NOW, { model: "Llama", everyone: true }),
            announce("@carol:x", "c1", NOW),
        ).summary(NOW, "@alice:x", "a1");
        expect(s).toMatchObject({ open: 3, ready: 2, forEveryone: 1, forUser: 2 });
        expect(s.peers[0].instance).toBe("a1");
        // Carol has no model and Alice answers only herself: just Bob's widget.
        expect(roster(announce("@alice:x", "a1", NOW, { model: "Qwen" }), announce("@bob:x", "b1", NOW, { model: "L", everyone: true })).summary(NOW, "@carol:x", "x").forUser).toBe(1);
    });

    it("drops widgets that said goodbye or went silent", () => {
        const r = roster(announce("@a:x", "a1", NOW - PRESENCE_TTL_MS - 1), announce("@b:x", "b1", NOW), announce("@b:x", "b1", NOW + 5, { online: false }));
        expect(r.summary(NOW + 10, null, "").open).toBe(0);
    });

    it("keeps the newest announcement even when an older one arrives later", () => {
        const r = roster(announce("@b:x", "b1", NOW + 5, { online: false }), announce("@b:x", "b1", NOW));
        expect(r.summary(NOW + 10, null, "").open).toBe(0);
    });

    it("sums donations per user over devices, counting each device once", () => {
        const r = roster(
            announce("@alice:x", "a1", NOW, { device: "laptop", donated: gave(2, 4000) }),
            // Same laptop, later page load: replaces, does not add.
            announce("@alice:x", "a2", NOW + 10, { device: "laptop", donated: gave(3, 6000) }),
            announce("@alice:x", "a3", NOW, { device: "desktop", donated: gave(1, 1000) }),
            announce("@bob:x", "b1", NOW, { donated: gave(1, 9000) }),
            announce("@carol:x", "c1", NOW),
        );
        expect(r.donors()).toEqual([
            { user: "@bob:x", donated: gave(1, 9000) },
            { user: "@alice:x", donated: gave(4, 7000) },
        ]);
    });
});
