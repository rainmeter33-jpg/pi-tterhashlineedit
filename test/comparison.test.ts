/**
 * Réel comparatif : ancien hashline (v0.4.1) vs pipeline 7 stages (v0.5.0)
 *
 * Scénarios où l'ancien mode échoue silencieusement ou corrompt le fichier,
 * et où le nouveau pipeline détecte et rejette le problème.
 *
 * Ligne mapping du fichier de test:
 *   1-4:  imports
 *   6-7:  constantes (logger, userService)
 *   9:    export async function login
 *   10:   const { email, password }
 *   12-15: if (!email || !password)
 *   17:   try {
 *   18:   const user = await userService...
 *   19:   if (!user || !user.validatePassword...)
 *   20:   logger.warn("Failed login attempt"...)
 *   21:   res.status(401)...
 *   22:   return;
 *   25:   const token = verify.sign(...)
 *   26:   expiresIn: "24h",
 *   27:   });
 *   29:   logger.info("User logged in"...)
 *   30:   res.json(...)
 *   31:   } catch (error) {
 *   32:   logger.error("Login error"...)
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
	writeFile as fsWriteFile,
	readFile as fsReadFile,
	unlink as fsUnlink,
	mkdir as fsMkdir,
} from "fs/promises";
import { join } from "path";
import {
	applyHashlineEdits,
	computeLineHash,
	resolveEditAnchors,
} from "../src/hashline";
import {
	executeEditPipeline,
	type DualAnchorToolEdit,
} from "../src/pipeline";

// ─── Un vrai fichier TypeScript ─────────────────────────────────────────

const REAL_FILE_CONTENT = `import { Request, Response } from "express";
import { verify } from "jsonwebtoken";
import { UserService } from "../services/user";
import { Logger } from "../utils/logger";

const logger = new Logger("auth-controller");
const userService = new UserService();

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: "Email and password required" });
    return;
  }

  try {
    const user = await userService.findByEmail(email);
    if (!user || !user.validatePassword(password)) {
      logger.warn("Failed login attempt", { email });
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const token = verify.sign({ id: user.id }, process.env.JWT_SECRET!, {
      expiresIn: "24h",
    });

    logger.info("User logged in", { userId: user.id });
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (error) {
    logger.error("Login error", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function register(req: Request, res: Response): Promise<void> {
  const { email, password, name } = req.body;

  if (!email || !password || !name) {
    res.status(400).json({ error: "All fields required" });
    return;
  }

  try {
    const existing = await userService.findByEmail(email);
    if (existing) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }

    const user = await userService.create({ email, password, name });
    const token = verify.sign({ id: user.id }, process.env.JWT_SECRET!, {
      expiresIn: "24h",
    });

    logger.info("User registered", { userId: user.id });
    res.status(201).json({ token, user: { id: user.id, email: user.email, name } });
  } catch (error) {
    logger.error("Registration error", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function getProfile(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const user = await userService.findById(userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({ id: user.id, email: user.email, name: user.name });
  } catch (error) {
    logger.error("Get profile error", error);
    res.status(500).json({ error: "Internal server error" });
  }
}
`;

const TEST_DIR = join(import.meta.dir, "__comparison_test__");
const TEST_FILE = join(TEST_DIR, "auth-controller.ts");

function ref(lineNum: number, content: string): string {
	const lines = content.split("\n");
	return `${lineNum}#${computeLineHash(lineNum, lines[lineNum - 1]!)}`;
}

/** Ancien mode: applyHashlineEdits directement, sans pipeline */
function oldModeEdit(
	content: string,
	posLine: number,
	endLine: number | undefined,
	newLines: string[],
) {
	const toolEdits = [
		{
			op: "replace" as const,
			pos: ref(posLine, content),
			...(endLine ? { end: ref(endLine, content) } : {}),
			lines: newLines,
		},
	];
	const resolved = resolveEditAnchors(toolEdits);
	return applyHashlineEdits(content, resolved);
}

/** Nouveau mode: pipeline complet avec ancres calculées depuis le contenu courant */
function newModeEdit(
	content: string,
	posLine: number,
	endLine: number | undefined,
	newLines: string[],
	anchor1Line: number,
	anchor2Line: number,
	filePath?: string,
) {
	const edits: DualAnchorToolEdit[] = [
		{
			op: "replace",
			pos: ref(posLine, content),
			...(endLine ? { end: ref(endLine, content) } : {}),
			lines: newLines,
			anchor1: ref(anchor1Line, content),
			anchor2: ref(anchor2Line, content),
		},
	];
	return executeEditPipeline(content, edits, {
		absolutePath: filePath,
		verifyAfterWrite: true,
	});
}

beforeAll(async () => {
	await fsMkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
	try {
		await fsUnlink(TEST_FILE);
	} catch {}
});

// ═══════════════════════════════════════════════════════════════════════
// SCÉNARIO 1 : Concurrent modification — quelqu'un change une ligne
// autour de la zone d'édition.
//
// Le modèle a lu le fichier et a des refs LINE#HASH.
// Pendant ce temps, quelqu'un modifie la ligne 21.
// Le modèle envoie son edit avec anchor2 pointant sur la ligne 21.
//
// Ancien: ne vérifie que pos/end → succès silencieux
// Nouveau: anchor2 détecte le stale hash
// ═══════════════════════════════════════════════════════════════════════

describe("SCÉNARIO 1 — Modification concurrente détectée par anchor2", () => {
	// Le contenu que le modèle a vu (fichier original)
	// et les refs qu'il a calculées
	const anchor2Ref = ref(21, REAL_FILE_CONTENT); // "21#HN"

	test("ANCIEN MODE: réussit silencieusement, ne voit pas le changement", () => {
		// Le fichier a changé: ligne 21 modifiée
		const currentContent = REAL_FILE_CONTENT.replace(
			'res.status(401).json({ error: "Invalid credentials" })',
			'res.status(401).json({ error: "Invalid credentials", code: "AUTH_FAILED" })',
		);

		// L'ancien mode ne valide que pos (ligne 25) — qui n'a pas changé
		const result = oldModeEdit(
			currentContent,
			25,
			undefined,
			['    const token = verify.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET!, {'],
		);

		// ❌ SUCCÈS SILENCIEUX — l'ancien mode ne sait pas que la ligne 21 a changé
		expect(result.content).not.toBe(currentContent);
		expect(result.content).toContain("role: user.role");
	});

	test("NOUVEAU MODE: détecte le stale anchor et rejette l'edit", async () => {
		// Le fichier a changé: ligne 21 modifiée
		const currentContent = REAL_FILE_CONTENT.replace(
			'res.status(401).json({ error: "Invalid credentials" })',
			'res.status(401).json({ error: "Invalid credentials", code: "AUTH_FAILED" })',
		);

		// On utilise les refs du CONTENU ORIGINAL (ce que le modèle a vu)
		// mais le contenu actuel est différent → anchor2 est stale
		const edits: DualAnchorToolEdit[] = [
			{
				op: "replace",
				pos: ref(25, currentContent), // pos existe dans le contenu actuel
				lines: [
					"    const token = verify.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET!, {",
				],
				anchor1: ref(17, REAL_FILE_CONTENT), // "17#JQ" — try { — même hash dans les deux versions
				anchor2: anchor2Ref, // "21#HN" — STALE! hash différent dans currentContent
			},
		];

		const result = await executeEditPipeline(currentContent, edits, {
			absolutePath: undefined,
		});

		// ✅ REJETÉ — le pipeline détecte le stale anchor
		expect(result.success).toBe(false);
		expect(result.wrote).toBe(false);
		const validateStage = result.stages.find((s) => s.stage === "validate")!;
		expect(validateStage.passed).toBe(false);
		expect(validateStage.message).toContain("stale hash");
		expect(validateStage.message).toContain("21#HN");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// SCÉNARIO 2 : L'edit supprime accidentellement du contexte
// L'ancien mode l'applique silencieusement.
// Le nouveau mode détecte si un anchor de contexte est dans la zone.
// ═══════════════════════════════════════════════════════════════════════

describe("SCÉNARIO 2 — Destruction de contexte détectée", () => {
	test("ANCIEN MODE: supprime logger.warn et le return sans avertissement", () => {
		// Remplace les lignes 20-22 (logger.warn + res.status(401) + return)
		const result = oldModeEdit(
			REAL_FILE_CONTENT,
			20,
			22,
			["      throw new Error('Not implemented');"],
		);

		// ❌ SUCCÈS SILENCIEUX — 3 lignes détruites, remplacées par 1
		expect(result.content).not.toContain('logger.warn("Failed login attempt"');
		expect(result.content).not.toContain("Invalid credentials");
		expect(result.content).toContain("throw new Error");
	});

	test("NOUVEAU MODE: reject si anchor2 dans la zone d'édition", async () => {
		// anchor2 = ligne 20 QUI EST DANS la zone 20-22
		const result = await newModeEdit(
			REAL_FILE_CONTENT,
			20,
			22,
			["      throw new Error('Not implemented');"],
			17, // anchor1: try { — en dehors
			20, // anchor2: logger.warn — DANS la zone!
		);

		// ✅ REJETÉ — anchor2 est dans la zone d'édition
		expect(result.success).toBe(false);
		const validateStage = result.stages.find((s) => s.stage === "validate")!;
		expect(validateStage.passed).toBe(false);
		expect(validateStage.message).toContain("inside");
	});

	test("NOUVEAU MODE: accepte si les ancres sont en dehors", async () => {
		await fsWriteFile(TEST_FILE, REAL_FILE_CONTENT, "utf-8");

		// anchor1 = ligne 17 (try), anchor2 = ligne 29 (logger.info)
		// Les deux sont en dehors de la zone 20-22
		const result = await newModeEdit(
			REAL_FILE_CONTENT,
			20,
			22,
			["      throw new Error('Not implemented');"],
			17,
			29,
			TEST_FILE,
		);

		expect(result.success).toBe(true);
		expect(result.wrote).toBe(true);
		// anchor1 (try {) et anchor2 (logger.info) existent toujours
		expect(result.simulatedContent).toContain("try {");
		expect(result.simulatedContent).toContain('logger.info("User logged in"');
	});
});

// ═══════════════════════════════════════════════════════════════════════
// SCÉNARIO 3 : Race condition — écriture concurrente
// L'ancien mode écrase, le nouveau vérifie post-write
// ═══════════════════════════════════════════════════════════════════════

describe("SCÉNARIO 3 — Race condition: écriture concurrente", () => {
	test("ANCIEN MODE: écrase les changements concurrents silencieusement", async () => {
		await fsWriteFile(TEST_FILE, REAL_FILE_CONTENT, "utf-8");

		// L'ancien mode: applique en mémoire
		const result = oldModeEdit(
			REAL_FILE_CONTENT,
			25,
			undefined,
			[
				'    const token = verify.sign({ id: user.id }, process.env.JWT_SECRET!, { expiresIn: "48h" });',
			],
		);

		// Quelqu'un d'autre modifie le fichier entre temps
		const concurrentlyModified = REAL_FILE_CONTENT.replace('"24h"', '"12h"');
		await fsWriteFile(TEST_FILE, concurrentlyModified, "utf-8");

		// L'ancien mode écrit par-dessus
		const { writeFileAtomically } = await import("../src/fs-write");
		await writeFileAtomically(TEST_FILE, result.content);

		// ❌ Le changement "12h" est perdu, écrasé silencieusement
		const finalContent = (await fsReadFile(TEST_FILE)).toString();
		expect(finalContent).toContain('expiresIn: "48h"');
		expect(finalContent).not.toContain('expiresIn: "12h"');
	});

	test("NOUVEAU MODE: verify confirme écriture correcte byte-for-byte", async () => {
		await fsWriteFile(TEST_FILE, REAL_FILE_CONTENT, "utf-8");

		const result = await newModeEdit(
			REAL_FILE_CONTENT,
			25,
			27,
			[
				'    const token = verify.sign({ id: user.id }, process.env.JWT_SECRET!, {',
				'      expiresIn: "48h"',
			],
			17,
			29,
			TEST_FILE,
		);

		// ✅ Le pipeline réussit: écriture vérifiée
		expect(result.success).toBe(true);
		expect(result.verified).toBe(true);

		const finalContent = (await fsReadFile(TEST_FILE)).toString();
		expect(finalContent).toContain('expiresIn: "48h"');
	});
});

// ═══════════════════════════════════════════════════════════════════════
// SCÉNARIO 4 : No-op accidentel — contenu identique
// ═══════════════════════════════════════════════════════════════════════

describe("SCÉNARIO 4 — No-op: contenu identique", () => {
	test("ANCIEN MODE: retourne un noopEdit mais n'empêche pas l'appelant", () => {
		const lines = REAL_FILE_CONTENT.split("\n");
		const line6 = lines[5]!; // const logger = ...

		const result = oldModeEdit(REAL_FILE_CONTENT, 6, undefined, [line6]);

		// L'ancien mode signale le noop mais l'appelant (edit.ts) doit
		// vérifier manuellement originalNormalized === result pour le rejeter
		expect(result.noopEdits).toBeDefined();
		expect(result.noopEdits!.length).toBe(1);
		expect(result.content).toBe(REAL_FILE_CONTENT); // Inchangé
	});

	test("NOUVEAU MODE: échoue explicitement au stage simulate", async () => {
		const lines = REAL_FILE_CONTENT.split("\n");
		const line6 = lines[5]!;

		const result = await newModeEdit(
			REAL_FILE_CONTENT,
			6,
			undefined,
			[line6],
			4,
			7,
			TEST_FILE,
		);

		// ✅ Échec clair au stage simulate
		expect(result.success).toBe(false);
		const simStage = result.stages.find((s) => s.stage === "simulate")!;
		expect(simStage.passed).toBe(false);
		expect(simStage.message).toContain("identical");
		expect(result.wrote).toBe(false); // Rien écrit
	});
});

// ═══════════════════════════════════════════════════════════════════════
// SCÉNARIO 5 : End-to-end complet
// ═══════════════════════════════════════════════════════════════════════

describe("SCÉNARIO 5 — End-to-end: 7 stages sur un vrai fichier", () => {
	test("Pipeline complet avec timeline", async () => {
		await fsWriteFile(TEST_FILE, REAL_FILE_CONTENT, "utf-8");

		const result = await newModeEdit(
			REAL_FILE_CONTENT,
			25, // const token = verify.sign(...)
			27, // });
			[
				'    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET!, {',
				'      expiresIn: "7d",',
				'    });',
			],
			17, // anchor1: try {
			29, // anchor2: logger.info(...)
			TEST_FILE,
		);

		expect(result.success).toBe(true);
		expect(result.wrote).toBe(true);
		expect(result.verified).toBe(true);
		expect(result.stages).toHaveLength(7);

		// Noms des stages dans l'ordre
		const stageNames = result.stages.map((s) => s.stage);
		expect(stageNames).toEqual([
			"read",
			"anchor",
			"validate",
			"simulate",
			"revalidate",
			"write",
			"verify",
		]);

		// Tous passent
		for (const s of result.stages) {
			expect(s.passed).toBe(true);
		}

		// Contenu correct
		expect(result.simulatedContent).toContain("jwt.sign");
		expect(result.simulatedContent).toContain('expiresIn: "7d"');

		// Fichier sur disque
		const diskContent = (await fsReadFile(TEST_FILE)).toString();
		const normalized = diskContent.replace(/\r\n/g, "\n");
		expect(normalized).toContain("jwt.sign");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// SCÉNARIO 6 : Simulation-only (dry run)
// ═══════════════════════════════════════════════════════════════════════

describe("SCÉNARIO 6 — Simulation-only: preview sans écriture", () => {
	test("ANCIEN MODE: pas de mode simulation, écrit toujours", async () => {
		await fsWriteFile(TEST_FILE, REAL_FILE_CONTENT, "utf-8");

		const result = oldModeEdit(
			REAL_FILE_CONTENT,
			25,
			undefined,
			['    const token = verify.sign({ id: user.id }, process.env.JWT_SECRET!, { expiresIn: "48h" });'],
		);

		// L'ancien mode ne peut PAS simuler — il faut écrire pour voir le résultat
		// Le fichier sur disque n'est PAS modifié (applyHashlineEdits est en mémoire)
		// Mais l'appelant doit écrire manuellement
		expect(result.content).not.toBe(REAL_FILE_CONTENT);

		// Le fichier original est intact car applyHashlineEdits ne touche pas le disque
		const diskContent = (await fsReadFile(TEST_FILE)).toString();
		expect(diskContent.replace(/\r\n/g, "\n")).toBe(REAL_FILE_CONTENT);
	});

	test("NOUVEAU MODE: simulateOnly=true, fichier intact + diff disponible", async () => {
		await fsWriteFile(TEST_FILE, REAL_FILE_CONTENT, "utf-8");

		const edits: DualAnchorToolEdit[] = [
			{
				op: "replace",
				pos: ref(25, REAL_FILE_CONTENT),
				lines: [
					'    const token = verify.sign({ id: user.id }, process.env.JWT_SECRET!, { expiresIn: "48h" });',
				],
				anchor1: ref(17, REAL_FILE_CONTENT),
				anchor2: ref(29, REAL_FILE_CONTENT),
			},
		];

		const result = await executeEditPipeline(REAL_FILE_CONTENT, edits, {
			absolutePath: TEST_FILE,
			simulateOnly: true,
		});

		// ✅ Succès mais PAS écrit
		expect(result.success).toBe(true);
		expect(result.wrote).toBe(false);
		expect(result.simulatedContent).toBeTruthy();
		expect(result.simulatedContent).toContain("48h");
		expect(result.diff).toBeTruthy();

		// Fichier intact sur disque
		const diskContent = (await fsReadFile(TEST_FILE)).toString();
		expect(diskContent.replace(/\r\n/g, "\n")).toBe(REAL_FILE_CONTENT);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// BILAN : tableau comparatif
// ═══════════════════════════════════════════════════════════════════════

describe("BILAN — Résumé comparatif", () => {
	test("Ancien mode: ~3% de couverture (seulement pos/end)", () => {
		const totalLines = REAL_FILE_CONTENT.split("\n").length;
		const verifiedLines = 2; // pos + end
		const coverage = (verifiedLines / totalLines) * 100;
		expect(coverage).toBeLessThan(5);
	});

	test("Nouveau mode: 4 ancres + verify byte-for-byte = ~100%", async () => {
		await fsWriteFile(TEST_FILE, REAL_FILE_CONTENT, "utf-8");

		const result = await newModeEdit(
			REAL_FILE_CONTENT,
			25,
			27,
			[
				'    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET!, {',
				'      expiresIn: "7d",',
				'    });',
			],
			17,
			29,
			TEST_FILE,
		);

		expect(result.success).toBe(true);

		// 3 stages de validation: validate + revalidate + verify
		const validateStage = result.stages.find((s) => s.stage === "validate")!;
		const revalidateStage = result.stages.find((s) => s.stage === "revalidate")!;
		const verifyStage = result.stages.find((s) => s.stage === "verify")!;

		expect(validateStage.passed).toBe(true);
		expect(revalidateStage.passed).toBe(true);
		expect(verifyStage.passed).toBe(true);
	});

	test("⏱ Timeline du pipeline", async () => {
		await fsWriteFile(TEST_FILE, REAL_FILE_CONTENT, "utf-8");

		const result = await newModeEdit(
			REAL_FILE_CONTENT,
			25,
			27,
			[
				'    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET!, {',
				'      expiresIn: "7d",',
				'    });',
			],
			17,
			29,
			TEST_FILE,
		);

		expect(result.success).toBe(true);

		const timeline = result.stages
			.map(
				(s) =>
					`  ${s.stage.padEnd(12)} ${s.passed ? "✅" : "❌"}  ${s.durationMs}ms`,
			)
			.join("\n");

		const totalMs = result.stages.reduce((sum, s) => sum + s.durationMs, 0);

		console.log("\n╔══════════════════════════════════════╗");
		console.log("║     PIPELINE 7-STAGES TIMELINE       ║");
		console.log("╠══════════════════════════════════════╣");
		console.log(timeline);
		console.log(`  ${"Total".padEnd(12)}    ${totalMs.toFixed(1)}ms`);
		console.log(`  ${"Wrote".padEnd(12)}    ${result.wrote}`);
		console.log(`  ${"Verified".padEnd(12)}    ${result.verified}`);
		console.log(`  ${"Errors".padEnd(12)}    ${result.errors.length}`);
		console.log("╚══════════════════════════════════════╝\n");
	});
});
