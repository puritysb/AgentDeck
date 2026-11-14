#if os(iOS)
import CloudKit
import OSLog
import UIKit
import UserNotifications

final class RemoteObservationAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        guard !AgentDeckApp.isHostedTest() else { return true }
        UNUserNotificationCenter.current().delegate = self
        RemoteObservationController.shared.start()
        return true
    }

    nonisolated private static func route(_ userInfo: [AnyHashable: Any]) -> (recognized: Bool, id: UUID?) {
        guard let notification = CKNotification(fromRemoteNotificationDictionary: userInfo) as? CKQueryNotification,
              notification.subscriptionID?.hasPrefix("remote-observation-v1-") == true else { return (false, nil) }
        // CloudKit may omit a record ID when coalescing notifications. Still open the summary.
        guard let recordID = notification.recordID else { return (true, nil) }
        guard recordID.zoneID.zoneName == RemoteObservationContract.zone else { return (false, nil) }
        return (true, UUID(uuidString: recordID.recordName))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let route = Self.route(notification.request.content.userInfo)
        if route.recognized {
            Task { @MainActor in await RemoteObservationController.shared.notificationArrived(id: route.id) }
            return [.banner, .list, .sound]
        }
        return [.banner, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
        let route = Self.route(response.notification.request.content.userInfo)
        guard route.recognized else { return }
        // Opening only selects the read-only tab; no daemon command or LAN connection is made here.
        Task { @MainActor in await RemoteObservationController.shared.notificationOpened(id: route.id) }
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        RemoteObservationController.shared.pushRegistrationChanged(confirmed: true)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        let failure = error as NSError
        Logger(subsystem: "bound.serendipity.agent.deck", category: "RemoteObservation")
            .error("APNs registration failed (\(failure.domain, privacy: .public), \(failure.code, privacy: .public))")
        RemoteObservationController.shared.pushRegistrationChanged(confirmed: false)
    }
}
#endif
