"""Constant-velocity Kalman filter with explicit prediction-only frames."""

import numpy as np


class ConstantVelocityTracker:
    def __init__(self, first_xy: tuple[float, float]):
        self.state = np.array([*first_xy, 0.0, 0.0], dtype=float)
        self.covariance = np.diag([100.0**2, 100.0**2, 30.0**2, 30.0**2])

    def predict(self, dt: float, sigma_a: float = 2.0) -> None:
        if dt <= 0:
            raise ValueError("Tracker timestamps must increase")
        f = np.array([[1, 0, dt, 0], [0, 1, 0, dt], [0, 0, 1, 0], [0, 0, 0, 1]])
        g = np.array([[dt * dt / 2, 0], [0, dt * dt / 2], [dt, 0], [0, dt]])
        self.state = f @ self.state
        self.covariance = f @ self.covariance @ f.T + sigma_a**2 * g @ g.T

    def update(self, measured_xy: tuple[float, float], sigma_m: float = 60.0) -> None:
        h = np.array([[1, 0, 0, 0], [0, 1, 0, 0]])
        r = np.eye(2) * sigma_m**2
        innovation = np.array(measured_xy) - h @ self.state
        s = h @ self.covariance @ h.T + r
        gain = np.linalg.solve(s, h @ self.covariance).T
        self.state += gain @ innovation
        identity_minus_kh = np.eye(4) - gain @ h
        self.covariance = identity_minus_kh @ self.covariance @ identity_minus_kh.T + gain @ r @ gain.T
