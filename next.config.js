module.exports = {
  async redirects() { return [{ source: "/", destination: "/routee.html", permanent: false }]; },
  async headers() { return [{ source: "/routee.html", headers: [{ key: "Cache-Control", value: "no-cache, must-revalidate" }] }]; }
};
 
