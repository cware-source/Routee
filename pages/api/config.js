export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.json({ gmapsKey: process.env.NEXT_PUBLIC_GMAPS_KEY || "" });
}
