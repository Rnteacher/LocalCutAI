const target = [...document.querySelectorAll("aside")].find((el) => el.textContent?.includes("Media") && el.textContent?.includes("+ Link"));
if (!target) throw new Error("media panel not found");
const dt = new DataTransfer();
const file = new File([new Uint8Array([1, 2, 3, 4])], "graph-qa-smoke.png", { type: "image/png" });
Object.defineProperty(file, "path", {
  value: "C:\\Users\\ronen\\AppData\\Local\\Temp\\localcut-link-smoke\\graph-qa-smoke.png",
});
dt.items.add(file);
for (const type of ["dragenter", "dragover", "drop"]) {
  target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
}
await new Promise((resolve) => setTimeout(resolve, 1500));
return "ok";
