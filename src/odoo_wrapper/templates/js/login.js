/*
 * The login page: the clock, the fields Odoo still needs, and the post to /api/login (server.py says what it
 * does with them). Its own file and not inline, so the Content-Security-Policy can refuse every inline script.
 *
 * - Off the machine itself (cfg.local false) the page only says how to pair the phone: the server refuses a
 *   password from the LAN anyway.
 * - Unconfigured, it asks for the URL and database too.
 * - When Odoo wants a two-factor code the server answers 401 with totp: the code field appears and the next
 *   post carries user, password and code together.
 */
const form = document.getElementById("login");
const err = document.getElementById("err");
const submit = document.getElementById("submit");
const clock = document.getElementById("clock");
const field = id => document.getElementById(id);

const tick = () => {
  const d = new Date();
  clock.textContent = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
tick();
setInterval(tick, 10000);

(async () => {
  const cfg = await (await fetch("/api/config")).json();
  field("user").value = cfg.user || "";
  if (!cfg.local) {
    field("hint").textContent = "Aquí no se inicia sesión. En el ordenador, abre http://localhost:8931/ y pulsa «Emparejar móvil»: escanea el código que aparece y entrarás sin contraseña.";
    for (const el of [field("user"), field("secret"), submit]) el.hidden = true;
    return;
  }
  if (!cfg.configured) {
    for (const id of ["url", "db"]) field(id).hidden = false;
    field("url").required = field("db").required = true;
  }
  field(cfg.user ? "pass" : cfg.configured ? "user" : "url").focus();
})();

field("eye").addEventListener("click", () => {
  const shown = field("pass").type === "password";
  field("pass").type = shown ? "text" : "password";
  field("eye-slash").classList.toggle("hidden", !shown);
  field("eye").setAttribute("aria-pressed", String(shown));
  field("eye").setAttribute("aria-label", shown ? "Ocultar contraseña" : "Mostrar contraseña");
  field("pass").focus();
});

form.addEventListener("submit", async e => {
  e.preventDefault();
  err.textContent = "";
  submit.disabled = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: field("url").value, db: field("db").value,
        user: field("user").value, password: field("pass").value, code: field("code").value,
      }),
    });
    if (res.ok) {
      location.replace("/");
      return;
    }
    const answer = await res.json();
    if (answer.totp) {
      field("hint").textContent = "Introduce el código de tu aplicación de verificación. Este navegador quedará como dispositivo de confianza 90 días.";
      field("code").hidden = false;
      field("code").required = true;
      submit.disabled = false;
      field("code").focus();
      return;
    }
    err.textContent = answer.error || `HTTP ${res.status}`;
  } catch (e) {
    err.textContent = e.message;
  }
  submit.disabled = false;
});
