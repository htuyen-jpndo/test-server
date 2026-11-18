import jwt from "jsonwebtoken";
import { User } from "../models/user.model.js";
import { isUserSuspended, sendSuspendedAccountResponse } from "../utils/userStatus.js";

export async function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findByPk(decoded.id, {
      attributes: ["id", "name", "email", "role", "status"],
    });
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }
    if (isUserSuspended(user)) {
      return sendSuspendedAccountResponse(res);
    }
    req.user = user.toJSON();
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}
