from calculator import add, subtract, multiply, divide, power, modulo
from utils import format_result, history_log

def run():
      print("=== Simple Calculator ===")
      print("Operations: +, -, *, /, **, %")
      print("Type 'exit' to quit\n")

      while True:
          try:
              a = input("Enter first number: ")
              if a.lower() == 'exit':
                  break
              op = input("Enter operator (+, -, *, /, **, %): ")
              b = input("Enter second number: ")

              a, b = float(a), float(b)

              if op == '+':
                  result = add(a, b)
              elif op == '-':
                  result = subtract(a, b)
              elif op == '*':
                  result = multiply(a, b)
              elif op == '/':
                  result = divide(a, b)
              elif op == '**':
                  result = power(a, b)
              elif op == '%':
                  result = modulo(a, b)
              else:
                  print("Invalid operator")
                  continue

              formatted_result = format_result(result)
              print(f"Result: {formatted_result}")
              history_log(a, op, b, result)

          except ValueError:
              print("Invalid input. Please enter numeric values.")
          except ZeroDivisionError:
              print("Cannot divide by zero.")