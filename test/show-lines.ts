const content = `import { Request, Response } from "express";
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
}`;

content.split("\n").forEach((l, i) => {
  const n = String(i + 1).padStart(3, " ");
  console.log(`${n}: ${l}`);
});
