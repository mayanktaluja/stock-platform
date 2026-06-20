const WHATSAPP_NUMBER = "919718213716";

const SERVICES = {
  custom: {
    label: "Custom Stitching",
    message:
      "Namaste Asha, I want to ask about custom stitching and fitting. Please share details and timing.",
  },
  bridal: {
    label: "Bridal Stitching",
    message:
      "Namaste Asha, I want to ask about bridal outfit stitching. Please share details and timing.",
  },
  blouse: {
    label: "Blouse Fitting",
    message:
      "Namaste Asha, I want to ask about blouse stitching/fitting. Please share details.",
  },
  saree: {
    label: "Saree Fitting",
    message:
      "Namaste Asha, I want to ask about saree fitting and blouse support. Please share details and timing.",
  },
  ready: {
    label: "Ready-made Wear",
    message:
      "Namaste Asha, I saw your ready-made collection online. Please share options in my size.",
  },
  suits: {
    label: "Suits",
    message:
      "Namaste Asha, I want to ask about suit stitching and fitting. Please share details and timing.",
  },
  coords: {
    label: "Co-ord Sets",
    message:
      "Namaste Asha, I want to ask about co-ord sets and fitting options. Please share details.",
  },
  bottoms: {
    label: "Bottom Wear",
    message:
      "Namaste Asha, I want to ask about pants and bottom wear fitting. Please share details.",
  },
  alterations: {
    label: "Alterations",
    message:
      "Namaste Asha, I want to ask about alteration/fitting support. Please share timing.",
  },
};

function whatsappUrl(message) {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

function setService(serviceKey) {
  const service = SERVICES[serviceKey] || SERVICES.custom;
  const url = whatsappUrl(service.message);

  document.querySelectorAll("[data-whatsapp-link]").forEach((link) => {
    link.setAttribute("href", url);
    link.setAttribute("aria-label", `WhatsApp Asha about ${service.label}`);
  });

  document.querySelectorAll("[data-selected-service]").forEach((node) => {
    node.textContent = service.label;
  });

  document.querySelectorAll(".service-chip").forEach((chip) => {
    const isSelected = chip.dataset.service === serviceKey;
    chip.classList.toggle("is-selected", isSelected);
    chip.setAttribute("aria-pressed", String(isSelected));
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".service-chip").forEach((chip) => {
    chip.addEventListener("click", () => setService(chip.dataset.service));
  });

  setService("custom");
});
