import random
from dataclasses import dataclass


@dataclass
class Weather:
    raining: bool = False
    sunlight: float = 1.0

    def step(self) -> None:
        if random.random() < 0.1:
            self.raining = not self.raining
        self.sunlight = 0.4 if self.raining else 1.0
