import Foundation

/// Presentation only: server availability, catalog membership and residency
/// are separate facts. Legacy VRAM=0 cannot prove that a model is unloaded.
enum LocalModelPresentation {
    static func mlx(models: [String], residency: ModelResidency?) -> String {
        if let residency, residency.known {
            return residency.models.isEmpty ? "No resident models" : "Resident: " + residency.models.joined(separator: ", ")
        }
        let reported = models.isEmpty ? "" : "\nReported: " + models.joined(separator: ", ")
        return "Residency unverified" + reported
    }

    static func ollama(_ status: OllamaStatus, compact: Bool = false) -> String {
        guard status.available else { return "Server unavailable" }
        let resident: String
        if let observation = status.residency {
            if observation.known {
                resident = compact || observation.models.isEmpty
                    ? "\(observation.models.count) resident"
                    : "Resident (\(observation.models.count)): " + observation.models.joined(separator: ", ")
            } else { resident = "Residency unverified" }
        } else {
            let gpu = status.models.filter { $0.sizeVram > 0 }
            resident = gpu.isEmpty ? "Residency unverified"
                : "GPU residency reported: " + gpu.map(\.name).joined(separator: ", ")
        }
        let catalog: String
        if status.installedModelsKnown == true {
            catalog = compact ? "\(status.models.count) installed"
                : "Installed (\(status.models.count)): " + (status.models.isEmpty ? "none" : status.models.map(\.name).joined(separator: ", "))
        } else {
            catalog = compact ? "Catalog unverified"
                : "Reported models (\(status.models.count)): " + (status.models.isEmpty ? "none" : status.models.map(\.name).joined(separator: ", "))
        }
        return compact ? "Available · \(resident) · \(catalog)" : "Server available · \(resident)\n\(catalog)"
    }
}
