import { describe, expect, it } from "vitest";
import { layout, path, reconcile, seeded, step, workSpot, type Hero } from "../../apps/web/src/lib/rpg/world";

/** The village of the Live screen: a lot per workspace around a plaza, walks along the roads, characters that follow the answers. */
const places = Array.from({ length: 10 }, (_, i) => ({ slug: `w${i}`, platform: i === 1 }));

describe("the village", () => {
  it("gives every workspace a lot, a platform workspace a castle, and leaves one plaza", () => {
    const map = layout(places);
    expect(map.lots.filter((lot) => lot.slug !== null).map((lot) => lot.slug).sort()).toEqual(places.map((place) => place.slug).sort());
    expect(map.lots.filter((lot) => lot.slug === null)).toHaveLength(1);
    expect(map.lots.find((lot) => lot.slug === "w1")?.platform).toBe(true);
    expect(map.lots.find((lot) => lot.slug === "w1")?.building.w).toBeGreaterThan(map.lots.find((lot) => lot.slug === "w0")?.building.w ?? 0);
  });

  it("finds a walk from the plaza to every door, along tiles that can be walked", () => {
    const map = layout(places);
    for (const lot of map.lots.filter((entry) => entry.slug !== null)) {
      const spot = workSpot(lot, 0);
      const route = path(map, map.spawn, { x: Math.round(spot.x), y: spot.y });
      expect(route.length).toBeGreaterThan(0);
      for (const tile of route.slice(0, -1)) expect(map.walk[tile.y * map.w + tile.x]).toBe(1);
      for (let i = 1; i < route.length; i += 1) expect(Math.abs((route[i]?.x ?? 0) - (route[i - 1]?.x ?? 0)) + Math.abs((route[i]?.y ?? 0) - (route[i - 1]?.y ?? 0))).toBe(1);
    }
  });

  it("puts what already runs at its door, walks a new attempt in from the plaza, never moves one back, and plays an ending before leaving", () => {
    const map = layout(places);
    const heroes = new Map<string, Hero>();
    const random = seeded(1);
    reconcile(heroes, map, { runs: [{ id: "a1", agent: "builder", kind: "work", slug: "w0", rootId: "g1" }], leaving: [], idle: [] }, 0, true, random);
    const first = heroes.get("a1");
    expect(first?.mode).toBe("work");
    expect(first?.route).toEqual([]);

    reconcile(heroes, map, { runs: [{ id: "a1", agent: "builder", kind: "work", slug: "w0", rootId: "g1" }, { id: "a2", agent: "reviewer", kind: "check", slug: "w2", rootId: "g2" }], leaving: [], idle: [] }, 1000, false, random);
    const second = heroes.get("a2");
    expect(second?.mode).toBe("arrive");
    expect([second?.x, second?.y]).toEqual([map.spawn.x, map.spawn.y]);
    for (let t = 0; t < 400 && heroes.get("a2")?.mode === "arrive"; t += 1) step(heroes, map, 100, 1000 + t * 100, random);
    expect(heroes.get("a2")?.mode).toBe("work");
    const before = { x: heroes.get("a1")?.x, y: heroes.get("a1")?.y };
    reconcile(heroes, map, { runs: [{ id: "a1", agent: "builder", kind: "work", slug: "w0", rootId: "g1" }, { id: "a2", agent: "reviewer", kind: "check", slug: "w2", rootId: "g2" }], leaving: [], idle: [] }, 60_000, false, random);
    expect({ x: heroes.get("a1")?.x, y: heroes.get("a1")?.y }).toEqual(before);

    reconcile(heroes, map, { runs: [{ id: "a2", agent: "reviewer", kind: "check", slug: "w2", rootId: "g2" }], leaving: [{ id: "a1", state: "done" }], idle: [] }, 70_000, false, random);
    expect(heroes.get("a1")?.mode).toBe("done");
    expect(heroes.get("a1")?.emote?.kind).toBe("ok");
    for (let t = 0; t < 600 && heroes.has("a1"); t += 1) step(heroes, map, 100, 70_000 + t * 100, random);
    expect(heroes.has("a1")).toBe(false);
  });

  it("sends a hero that finished to the next hero of the same goal with its scroll, across the village, before it leaves", () => {
    const map = layout(places);
    const heroes = new Map<string, Hero>();
    const random = seeded(3);
    reconcile(heroes, map, { runs: [{ id: "p1", agent: "planner", kind: "work", slug: "w0", rootId: "g" }], leaving: [], idle: [] }, 0, true, random);
    reconcile(heroes, map, { runs: [{ id: "b1", agent: "builder", kind: "work", slug: "w5", rootId: "g" }], leaving: [{ id: "p1", state: "done" }], idle: [] }, 1000, false, random);
    const planner = heroes.get("p1");
    expect(planner?.mode).toBe("handoff");
    expect(planner?.partner).toBe("b1");
    const lot = map.lots.find((entry) => entry.slug === "w5");
    let gave = false;
    for (let t = 0; t < 800 && heroes.has("p1"); t += 1) {
      step(heroes, map, 100, 1000 + t * 100, random);
      if (heroes.get("p1")?.emote?.kind === "scroll") {
        gave = true;
        expect(heroes.get("p1")?.x).toBeGreaterThanOrEqual(lot?.x ?? 0);
        expect(heroes.get("b1")?.emote?.kind).toBe("heart");
      }
    }
    expect(gave).toBe(true);
    expect(heroes.has("p1")).toBe(false);
  });

  it("lets an agent that acted lately wander in its own yard, and sends it away when it works or is forgotten", () => {
    const map = layout(places);
    const heroes = new Map<string, Hero>();
    const random = seeded(2);
    reconcile(heroes, map, { runs: [], leaving: [], idle: [{ slug: "w3", agent: "scribe" }] }, 0, true, random);
    const lot = map.lots.find((entry) => entry.slug === "w3");
    for (let t = 0; t < 300; t += 1) {
      step(heroes, map, 100, t * 100, random);
      const hero = heroes.get("w:w3:scribe");
      expect(hero?.mode).toBe("wander");
      expect(hero?.x).toBeGreaterThanOrEqual(lot?.x ?? 0);
      expect(hero?.x).toBeLessThan((lot?.x ?? 0) + 14);
    }
    reconcile(heroes, map, { runs: [], leaving: [], idle: [] }, 40_000, false, random);
    expect(heroes.has("w:w3:scribe")).toBe(false);
  });
});
