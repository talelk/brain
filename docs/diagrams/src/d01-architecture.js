const L = require("./lib");
const { lane, cyl, edge, text, badge } = L;
const { STYLE, bcard, bchip, blegend } = require("./big");

// Pastille = section de docs/architecture.md. Colonnes : 4 cartes de 288 de large, pas de 322.
const X = (i) => 32 + i * 322;
const W = 288;
const sec = (label, i, y) => badge(label, X(i) + W - 6, y + 8);
const OVERRIDE = `<style>.tname{font-size:16px} .sub{font-size:14.5px} .sub.sm{font-size:13.5px} .stage{font-size:11.5px} .zlabel{font-size:12.5px} .legend{font-size:14.5px} .elabel{font-size:13px} .mono{font-size:14px}</style>`;

module.exports = {
  id: "d01-architecture-brain", w: 1320, h: 1400,
  title: "Brain — Architecture détaillée",
  desc: "Un Governor (API, app web, SQLite, journal d'audit chaîné) reçoit les personnes, GitHub et l'horloge ; des runners enrôlés prennent les tentatives, les exécutent dans des sandboxes Docker lancées par le launcher, derrière un proxy de sortie, et appellent les modèles par la passerelle du Governor et se passent l'état du travail par un store git qui ne parle jamais au Governor.",
  build() {
    let s = STYLE + OVERRIDE;

    // ---------- ENTRÉES ----------
    s += lane(16, 16, 1288, 158, "ENTRÉES · QUI DÉMARRE UN TRAVAIL");
    const A = [
      ["solid", "NAVIGATEUR", "Application web", ["SolidJS, 16 écrans, SSE", "FR · EN · AR, clair · sombre"], "blue", "§10"],
      ["pnpm", "TERMINAL", "pnpm brain", ["start, runner, backup,", "restore, audit-verify"], "blue", ""],
      ["github", "SIGNAL EXTERNE", "Webhooks GitHub", ["signature vérifiée,", "une livraison = un Play"], "blue", "§9"],
      ["cron", "HORLOGE", "Planification", ["cron, fuseau du workspace,", "heure manquée : ignorée"], "blue", "§9"],
    ];
    A.forEach(([lg, st, nm, sb, cls, b], i) => { s += bcard({ x: X(i), y: 44, w: W, h: 120, logo: lg, stage: st, name: nm, sub: sb, cls }) + (b ? sec(b, i, 44) : ""); });

    // ---------- GOVERNOR ----------
    const gy = 186;
    s += lane(16, gy, 1288, 356, "GOVERNOR · UN PROCESSUS");
    const r1 = gy + 40, r2 = gy + 162, r3 = gy + 284;
    const B1 = [
      ["hono", "ENTRÉE", "API", ["commandes et requêtes,", "une transaction chacune"], "", "§4"],
      ["auth", "ACCÈS", "Connexion et rôles", ["membres, groupes, invités", "admin d'instance : tout voir"], "", "§4"],
      ["trigger", "DÉMARRAGE", "Déclencheurs", ["cron et webhooks démarrent", "un Play, une seule fois"], "", "§9"],
      ["plays", "TRAVAIL", "Tâches et Plays", ["but, plan, tâches,", "contrôle, guérison"], "green", "§5"],
    ];
    B1.forEach(([lg, st, nm, sb, cls, b], i) => { s += bcard({ x: X(i), y: r1, w: W, h: 100, logo: lg, stage: st, name: nm, sub: sb, cls }) + sec(b, i, r1); });
    const B2 = [
      ["gateway", "MODÈLE", "Passerelle modèle", ["jeton par tentative,", "clés gardées, coût compté"], "violet", "§6"],
      ["approvals", "CONFIANCE", "Approbations, secrets", ["effets validés par une", "personne, secrets chiffrés"], "orange", "§3"],
      ["tools", "OUTILS", "Outils de Brain", ["task.*, memory.*, ask,", "git.open-pr, message.send"], "", "§7"],
      ["queue", "DISTRIBUTION", "File d'attente", ["priorité, tour par workspace,", "bail 60 s, fence"], "green", "§6"],
    ];
    B2.forEach(([lg, st, nm, sb, cls, b], i) => { s += bcard({ x: X(i), y: r2, w: W, h: 100, logo: lg, stage: st, name: nm, sub: sb, cls }) + sec(b, i, r2); });
    const B3 = [
      ["git", "Workspace", "dossier git, snapshot validé", "§2"],
      ["fts", "Mémoire", "index FTS5, propositions", ""],
      ["integrations", "Intégrations", "PR, push git, Teams", "§9"],
      ["health", "Santé et sauvegarde", "runners, modèles, backup", "§9"],
    ];
    B3.forEach(([lg, nm, sb, b], i) => { s += bchip({ x: X(i), y: r3, w: W, logo: lg, name: nm, sub: sb }) + (b ? sec(b, i, r3 - 2) : ""); });

    // flèches des entrées vers le Governor
    s += edge([[290, 164], [290, r1]], "data", "HTTPS · SSE", 300, 207, { anchor: "start" });
    s += edge([[X(2) + W / 2, 164], [X(2) + W / 2, r1]], "data", "webhook", X(2) + W / 2 - 14, 214, { anchor: "end" });
    s += edge([[X(3) + W / 2, 164], [X(3) + W / 2, 200], [X(2) + 230, 200], [X(2) + 230, r1]], "ctl");
    // dans le Governor
    s += edge([[X(2) + W, r1 + 50], [X(3), r1 + 50]], "data");
    s += edge([[X(3) + W / 2, r1 + 100], [X(3) + W / 2, r2]], "data", "crée des tentatives", X(3) + W / 2 + 12, r1 + 116, { anchor: "start" });

    // ---------- STOCKAGE ----------
    const sy = 554, cy = sy + 40, ch = 124;
    s += lane(16, sy, 1288, 222, "STOCKAGE");
    s += cyl({ x: 40, y: cy, w: 130, h: ch, kind: "silver", name: "brain.db", sub: "SQLite", logo: "sqlite" });
    s += cyl({ x: 190, y: cy, w: 130, h: ch, kind: "silver", name: "cas/", sub: "octets par contenu" });
    s += cyl({ x: 340, y: cy, w: 130, h: ch, kind: "silver", name: "workspaces/", sub: "un dépôt git chacun", logo: "git" });
    s += cyl({ x: 490, y: cy, w: 130, h: ch, kind: "silver", name: "store/", sub: "service à part", logo: "git" });
    s += text(105, cy + ch + 20, "35 tables, plus celles", "sub sm", "middle") + text(105, cy + ch + 38, "de connexion", "sub sm", "middle");
    s += text(255, cy + ch + 20, "patchs, fichiers,", "sub sm", "middle") + text(255, cy + ch + 38, "sorties d'attempts", "sub sm", "middle");
    s += text(405, cy + ch + 20, "brain.toml, agents/,", "sub sm", "middle") + text(405, cy + ch + 38, "tools/, plays/, memory/", "sub sm", "middle");
    s += text(555, cy + ch + 20, "états des tentatives,", "sub sm", "middle") + text(555, cy + ch + 38, "hors du Governor", "sub sm", "middle");
    s += bcard({ x: 660, y: cy, w: 310, h: ch, stage: "UNE SEULE CHAÎNE", name: "Journal d'audit", sub: ["chaque changement d'état,", "même transaction, hash chaîné,", "points de contrôle signés"], cls: "blue" });
    s += bcard({ x: 990, y: cy, w: 296, h: ch, stage: "CLÉS", name: "instance.key · audit/", sub: ["chiffre les secrets,", "signe le journal"], cls: "orange" });
    s += badge("§3", 664 + 306 - 6 - 6, cy + 8);
    [105, 255, 405].forEach((x) => { s += edge([[x, 542], [x, cy]], "data", undefined, 0, 0, { both: true }); });
    s += text(540, 572, "lit · écrit", "sub sm");

    // ---------- EXÉCUTION ----------
    const dy = 788, d1 = dy + 40, d2 = dy + 162;
    s += lane(16, dy, 1288, 276, "EXÉCUTION · SUR LES MACHINES DES RUNNERS");
    const D1 = [
      [null, "DISQUE DU RUNNER", "Copies de travail", ["une copie par tentative,", "état poussé au store"], "", "§8"],
      [null, "HÔTE", "Commandes hôte", ["liste fermée du launcher,", "approbation requise"], "orange", "§7"],
      ["docker", "SEUL ACCÈS À DOCKER", "Launcher", ["socket et jeton,", "lance les sandboxes"], "orange", ""],
      ["runner", "SE CONNECTE EN SORTANT", "Runner", ["enrôlé (ed25519), slots,", "reçu signé par tentative"], "green", "§6"],
    ];
    D1.forEach(([lg, st, nm, sb, cls, b], i) => { s += bcard({ x: X(i), y: d1, w: W, h: 100, ...(lg ? { logo: lg } : {}), stage: st, name: nm, sub: sb, cls }) + (b ? sec(b, i, d1) : ""); });
    const D2 = [
      ["engines", "MOTEUR DE L'AGENT", "Pi · Claude · ACP", ["choisi dans agent.toml,", "fixture pour les tests"], "", ""],
      ["docker", "CONTENEUR DURCI", "Sandbox moteur", ["/work /out /state,", "sans réseau libre"], "orange", "§8"],
      ["docker", "CONTENEUR PAR APPEL", "Sandbox outil", ["run.sh, secrets prêtés,", "réseau : hôtes déclarés"], "orange", "§7"],
      ["egress", "SEULE SORTIE", "Proxy de sortie", ["passerelle du Governor", "et hôtes du projet"], "orange", ""],
    ];
    D2.forEach(([lg, st, nm, sb, cls, b], i) => { s += bcard({ x: X(i), y: d2, w: W, h: 100, logo: lg, stage: st, name: nm, sub: sb, cls }) + (b ? sec(b, i, d2) : ""); });
    s += edge([[X(3), d1 + 50], [X(2) + W, d1 + 50]], "data");
    s += edge([[X(2), d1 + 50], [X(1) + W, d1 + 50]], "data");
    s += edge([[X(2) + W / 2, d1 + 100], [X(2) + W / 2, d2]], "data", "docker run", X(2) + W / 2 + 8, d1 + 116, { anchor: "start" });
    s += edge([[X(2) + 60, d1 + 100], [X(2) + 60, d1 + 111], [X(1) + W / 2, d1 + 111], [X(1) + W / 2, d2]], "data");
    s += edge([[X(0) + W, d2 + 50], [X(1), d2 + 50]], "data");
    s += edge([[X(2) + W, d2 + 50], [X(3), d2 + 50]], "data");

    // ---------- EXTERNE ----------
    const ey = 1076, e1 = ey + 40;
    s += lane(16, ey, 1288, 112, "EXTERNE · CE QUE BRAIN APPELLE");
    s += bchip({ x: X(0), y: e1, w: W, logo: "anthropic", name: "Modèles", sub: "OpenAI-compatible, Anthropic" });
    s += bchip({ x: X(1), y: e1, w: W, logo: "github", name: "GitHub", sub: "dépôts, pull requests" });
    s += bchip({ x: X(2), y: e1, w: W, logo: "teams", name: "Teams et courriel", sub: "cartes, invitations (SMTP)" });
    s += bchip({ x: X(3), y: e1, w: W, logo: "npm", name: "Registres de paquets", sub: "hôtes déclarés du projet" });
    s += edge([[X(3) + W / 2, d2 + 100], [X(3) + W / 2, e1]], "data", "hôtes autorisés", X(3) + W / 2 + 8, d2 + 124, { anchor: "start", onbg: true });

    // ---------- DÉPLOIEMENT ----------
    const py = 1200, p1 = py + 40;
    s += lane(16, py, 1288, 112, "DÉPLOIEMENT · HÔTE DE DÉMO");
    s += bchip({ x: X(0), y: p1, w: W, logo: "nginx", name: "nginx", sub: "TLS, brain.mykeyrus.tn" });
    s += bchip({ x: X(1), y: p1, w: W, logo: "docker", name: "Governor en conteneur", sub: "compose, /health/ready" });
    s += bchip({ x: X(2), y: p1, w: W, logo: "linux", name: "Launcher, store, runner", sub: "services systemd de l'hôte" });
    s += bchip({ x: X(3), y: p1, w: W, logo: "backup", name: "Sauvegarde", sub: "archive tar.gz, minuterie" });
    s += edge([[X(0) + W, p1 + 29], [X(1), p1 + 29]], "data");

    // ---------- Lignes qui longent les bandes ----------
    // passerelle -> modèles, par la marge de gauche ; runner <-> file d'attente, par la marge de droite
    s += edge([[X(0), r2 + 50], [8, r2 + 50], [8, e1 + 29], [X(0), e1 + 29]], "data", "appel des modèles", 0, 0);
    s += `<text class="elabel onbg" transform="rotate(-90 22 ${r2 + 330})" x="22" y="${r2 + 330}" text-anchor="middle">modèle · par la passerelle seulement</text>`;
    s += edge([[X(3) + W, d1 + 50], [1312, d1 + 50], [1312, r2 + 50], [X(3) + W, r2 + 50]], "data", undefined, 0, 0, { both: true });
    s += `<text class="elabel onbg" transform="rotate(-90 1300 640)" x="1300" y="640" text-anchor="middle">/runner/v1 · claim, events, complete</text>`;

    // ---------- Légende ----------
    s += blegend(32, 1346, [{ type: "data", label: "Données" }, { type: "ctl", label: "Planification" }]);
    s += text(330, 1351, "Pastille § = section de docs/architecture.md · bordure orange = isolation ou secret · une seule base SQLite, un seul Governor", "legend");
    s += text(32, 1380, "Les runners se connectent vers le Governor, jamais l'inverse. Rien ne sort d'une sandbox sans passer par le proxy de sortie.", "sub sm");
    return s;
  },
};
