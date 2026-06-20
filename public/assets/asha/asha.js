const WHATSAPP_NUMBER = "919718213716";

const SERVICES = {
  custom: {
    label: "Custom Stitching",
    message: "Namaste Asha, I need help with custom stitching and fitting. Please guide me.",
  },
  "blouse-saree": {
    label: "Blouse & Saree Fitting",
    message:
      "Namaste Asha, I need blouse or saree fitting support. Please share details and timing.",
  },
  bridal: {
    label: "Bridal & Occasion Wear",
    message:
      "Namaste Asha, I need bridal or occasion wear fitting/stitching support. Please guide me.",
  },
  alterations: {
    label: "Alterations",
    message: "Namaste Asha, I need alteration/fitting support. Please share timing.",
  },
  ready: {
    label: "Ready-made Ethnic Wear",
    message:
      "Namaste Asha, I am looking for ready-made ethnic wear. Please share available options.",
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

  document.querySelectorAll("[data-service]").forEach((button) => {
    const isSelected = button.dataset.service === serviceKey;
    button.classList.toggle("is-selected", isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
  });

  document.querySelectorAll("[data-service-card]").forEach((card) => {
    card.classList.toggle("is-selected", card.dataset.serviceCard === serviceKey);
  });
}

function setupStickyCta() {
  const sticky = document.querySelector("[data-testid='sticky-cta']");
  const hero = document.querySelector("[data-hero]");
  const contact = document.querySelector("[data-contact-section]");
  if (!sticky || !hero) return;

  const update = () => {
    const heroThreshold = Math.min(hero.offsetHeight * 0.72, 620);
    const contactTop = contact ? contact.getBoundingClientRect().top : Number.POSITIVE_INFINITY;
    const pastHero = window.scrollY > heroThreshold;
    const beforeContact = contactTop > window.innerHeight - 96;
    const showSticky = pastHero && beforeContact;

    sticky.classList.toggle("is-visible", showSticky);
    sticky.classList.toggle("is-muted", !showSticky);
    sticky.setAttribute("aria-hidden", String(!showSticky));
  };

  update();
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-service]").forEach((button) => {
    button.addEventListener("click", () => setService(button.dataset.service));
  });

  setService("custom");
  setupStickyCta();
});
