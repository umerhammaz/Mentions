    function enterDemoMode() {
      tokenSet(location.origin, "demo-offline-token");
      if (state.commands.length === 0) {
        const now = new Date().toISOString();
        set("commands", [
          { id: "demo-1", trigger: "@sig", text: "Best regards,\nAyesha Khan · Product", enabled: true, createdAt: now, updatedAt: now },
          { id: "demo-2", trigger: "@thanks", text: "Thanks for the quick reply — I'll take a look this afternoon.", enabled: true, createdAt: now, updatedAt: now },
        ]);
      }
      announce("Entered offline preview mode.");
      navigate("/");
    }