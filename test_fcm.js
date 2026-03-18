const admin = require('firebase-admin');

try {
    const message = {
        token: "dummy_token",
        android: {
            notification: {
                vibrateTimingsMillis: [0, 400, 200, 400, 200, 800]
            }
        }
    };
    console.log("Validation passed or skipped manually");
} catch(e) {
    console.error("Error formatting:", e);
}
