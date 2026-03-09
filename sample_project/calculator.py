import math

def add(a, b):
    return a + b

def subtract(a, b):
    return a - b

def multiply(a, b):
    return a * b

def divide(a, b):
    if b == 0:
        raise ValueError("Cannot divide by zero")
    return a / b

def modulo(a, b):
    if b == 0:
        raise ValueError("Cannot modulo by zero")
    return a % b

def power(a, b):
    """ಈ ಫಂಕ್ಷನ್ ಮೊದಲ ನಂಬರ್‌ನ ಎರಡನೇ ನಂಬರ್ ಪವರ್ ಹಿಂತಿರುಗಿಸುತ್ತದೆ."""
    return a ** b

def log(a, base=math.e):
    """ಈ ಫಂಕ್ಷನ್ ನೀಡಲಾದ ನಂಬರ್‌ನ ಲಾಗರಿದಮ್ ಹಿಂತಿರುಗಿಸುತ್ತದೆ. ಬೇಸ್ ಇಲ್ಲದಿದ್ದರೆ ಇ ಬಳಸಲಾಗುತ್ತದೆ."""
    if a <= 0:
        raise ValueError("ಲಾಗರಿದಮ್ ಕಂಡುಹಿಡಿಯಲು ನಂಬರ್ ಧನಾತ್ಮಕವಾಗಿರಬೇಕು")
    return math.log(a, base)

def root(a, n=2):
    """ಈ ಫಂಕ್ಷನ್ ನೀಡಲಾದ ನಂಬರ್‌ನ ಮೂಲ ಹಿಂತಿರುಗಿಸುತ್ತದೆ. ಮೂಲ ಬಗೆ ಇಲ್ಲದಿದ್ದರೆ 2 ಬಳಸಲಾಗುತ್ತದೆ."""
    if a < 0 and n % 2 == 0:
        raise ValueError("ಋಣ ನಂಬರ್‌ಗಳಿಗೆ ಸಮ ಮೂಲ ಇರುವುದಿಲ್ಲ")
    return a ** (1 / n)

def sine(angle):
    """ಈ ಫಂಕ್ಷನ್ ನೀಡಲಾದ ಕೋನದ ಸೈನ್ ಮೌಲ್ಯವನ್ನು ಹಿಂತಿರುಗಿಸುತ್ತದೆ."""
    return math.sin(math.radians(angle))

def cosine(angle):
    """ಈ ಫಂಕ್ಷನ್ ನೀಡಲಾದ ಕೋನದ ಕೋಸೈನ್ ಮೌಲ್ಯವನ್ನು ಹಿಂತಿರುಗಿಸುತ್ತದೆ."""
    return math.cos(math.radians(angle))

def tangent(angle):
    """ಈ ಫಂಕ್ಷನ್ ನೀಡಲಾದ ಕೋನದ ಟ್ಯಾಂಜೆಂಟ್ ಮೌಲ್ಯವನ್ನು ಹಿಂತಿರುಗಿಸುತ್ತದೆ."""
    return math.tan(math.radians(angle))

def arcsine(value):
    """ಈ ಫಂಕ್ಷನ್ ನೀಡಲಾದ ಮೌಲ್ಯದ ಆರ್ಕ್ಸೈನ್ ಹಿಂತಿರುಗಿಸುತ್ತದೆ."""
    if value < -1 or value > 1:
        raise ValueError("ಆರ್ಕ್ಸೈನ್ ಕಂಡುಹಿಡಿಯಲು ಮೌಲ್ಯ -1 ಮತ್ತು 1 ನಡುವೆ ಇರಬೇಕು")
    return math.degrees(math.asin(value))

def arccosine(value):
    """ಈ ಫಂಕ್ಷನ್ ನೀಡಲಾದ ಮೌಲ್ಯದ ಆರ್ಕ್ಕೋಸೈನ್ ಹಿಂತಿರುಗಿಸುತ್ತದೆ."""
    if value < -1 or value > 1:
        raise ValueError("ಆರ್ಕ್ಕೋಸೈನ್ ಕಂಡುಹಿಡಿಯಲು ಮೌಲ್ಯ -1 ಮತ್ತು 1 ನಡುವೆ ಇರಬೇಕು")
    return math.degrees(math.acos(value))

def arctangent(value):
    """ಈ ಫಂಕ್ಷನ್ ನೀಡಲಾದ ಮೌಲ್ಯದ ಆರ್ಕ್ಟ್ಯಾಂಜೆಂಟ್ ಹಿಂತಿರುಗಿಸುತ್ತದೆ."""
    return math.degrees(math.atan(value))